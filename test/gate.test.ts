import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEEPSEEK_PATTERNS,
  MINIMAL_CORE_TOOLS,
  WHITELIST_ALL_SENTINEL,
  allowedTools,
  desiredActiveTools,
  isDeepSeekModel,
  isMinimalActive,
  parseMinimalModeConfig,
  registeredWhitelistTools,
  shouldBlockTool,
  _setConfigForTesting,
  type GatableModel,
  type MinimalModeConfig,
} from "../src/gate.js";

afterEach(() => {
  _setConfigForTesting(null);
});

function config(overrides: Partial<MinimalModeConfig> = {}): MinimalModeConfig {
  return {
    mode: "auto",
    profile: "strict",
    deepseekPatterns: DEFAULT_DEEPSEEK_PATTERNS,
    whitelist: [],
    ...overrides,
  };
}

function model(overrides: Partial<GatableModel> = {}): GatableModel {
  return { id: "glm-5.2-short", provider: "neuralwatt", api: "openai-completions", ...overrides };
}

const deepseek = model({ id: "deepseek-v4-flash" });

describe("config parsing", () => {
  it("defaults missing and invalid profiles to strict", () => {
    expect(parseMinimalModeConfig(undefined).profile).toBe("strict");
    expect(parseMinimalModeConfig({ profile: "legacy" }).profile).toBe("strict");
  });

  it("accepts augmented and preserves whitelist order", () => {
    const parsed = parseMinimalModeConfig({ profile: "augmented", whitelist: ["todo", "ask_user", "todo"] });
    expect(parsed.profile).toBe("augmented");
    expect(parsed.whitelist).toEqual(["todo", "ask_user", "todo"]);
  });

  it("preserves existing mode and model-pattern parsing", () => {
    const parsed = parseMinimalModeConfig({ mode: "on", deepseekPatterns: ["^ds-", "["] });
    expect(parsed.mode).toBe("on");
    expect(parsed.deepseekPatterns).toHaveLength(1);
    expect(parsed.deepseekPatterns[0].test("DS-model")).toBe(true);
  });
});

describe("model matching", () => {
  it("matches deepseek in id, provider, or name", () => {
    expect(isDeepSeekModel(deepseek)).toBe(true);
    expect(isDeepSeekModel(model({ provider: "deepseek", id: "v4" }))).toBe(true);
    expect(isDeepSeekModel(model({ id: "x", name: "DeepSeek V4" }))).toBe(true);
    expect(isDeepSeekModel(model())).toBe(false);
    expect(isDeepSeekModel(undefined)).toBe(false);
  });

  it("respects auto, on, and off", () => {
    _setConfigForTesting(config());
    expect(isMinimalActive(deepseek)).toBe(true);
    expect(isMinimalActive(model())).toBe(false);
    _setConfigForTesting(config({ mode: "on" }));
    expect(isMinimalActive(model())).toBe(true);
    _setConfigForTesting(config({ mode: "off" }));
    expect(isMinimalActive(deepseek)).toBe(false);
  });
});

describe("direct active-tool policy", () => {
  it("strict always resolves to the Harness pair in Harness order", () => {
    _setConfigForTesting(config({ whitelist: ["ask_user"] }));
    expect(desiredActiveTools(deepseek, ["ask_user", "bash"], new Set(["ask_user"]))).toEqual([
      "bash",
      "str_replace_editor",
    ]);
    expect(desiredActiveTools(deepseek, [...MINIMAL_CORE_TOOLS], new Set(["ask_user"]))).toBeNull();
  });

  it("augmented force-adds unique registered whitelist tools in config order", () => {
    const augmented = config({
      profile: "augmented",
      whitelist: ["todo", "bash", "ask_user", "todo", "missing"],
    });
    _setConfigForTesting(augmented);
    const registered = new Set(["bash", "str_replace_editor", "ask_user", "todo"]);
    expect(registeredWhitelistTools(augmented, registered)).toEqual(["todo", "ask_user"]);
    expect(desiredActiveTools(deepseek, ["bash"], registered)).toEqual([
      "bash",
      "str_replace_editor",
      "todo",
      "ask_user",
    ]);
    expect([...allowedTools(deepseek, registered)]).toEqual([
      "bash",
      "str_replace_editor",
      "todo",
      "ask_user",
    ]);
  });

  it("expands the all-tools sentinel to every registered non-core, non-swap tool", () => {
    _setConfigForTesting(config({ profile: "augmented", whitelist: [WHITELIST_ALL_SENTINEL] }));
    const registered = new Set([
      "bash",
      "str_replace_editor",
      "read",
      "edit",
      "write",
      "grep",
      "apply_patch",
      "ask_user",
      "todo",
      "memo",
    ]);
    expect(registeredWhitelistTools(config({ profile: "augmented", whitelist: [WHITELIST_ALL_SENTINEL] }), registered)).toEqual(
      ["grep", "ask_user", "todo", "memo"],
    );
    expect([...allowedTools(deepseek, registered)]).toEqual([
      "bash",
      "str_replace_editor",
      "grep",
      "ask_user",
      "todo",
      "memo",
    ]);
  });

  it("never surfaces the GPT-only apply_patch even when whitelisted explicitly", () => {
    _setConfigForTesting(config({ profile: "augmented", whitelist: ["apply_patch", "ask_user"] }));
    const registered = new Set(["bash", "str_replace_editor", "apply_patch", "ask_user"]);
    expect(registeredWhitelistTools(config({ profile: "augmented", whitelist: ["apply_patch", "ask_user"] }), registered)).toEqual(
      ["ask_user"],
    );
    expect([...allowedTools(deepseek, registered)]).toEqual(["bash", "str_replace_editor", "ask_user"]);
    expect(shouldBlockTool("apply_patch", deepseek, registered)).toBe(true);
    expect(shouldBlockTool("ask_user", deepseek, registered)).toBe(false);
  });

  it("mixes the sentinel with explicit names without duplication", () => {
    _setConfigForTesting(config({ profile: "augmented", whitelist: ["ask_user", WHITELIST_ALL_SENTINEL] }));
    const registered = new Set(["bash", "str_replace_editor", "read", "ask_user", "todo"]);
    expect(registeredWhitelistTools(config({ profile: "augmented", whitelist: ["ask_user", WHITELIST_ALL_SENTINEL] }), registered)).toEqual(
      ["ask_user", "todo"],
    );
  });

  it("restores a registered extra removed by an earlier gate", () => {
    _setConfigForTesting(config({ profile: "augmented", whitelist: ["grep"] }));
    expect(desiredActiveTools(deepseek, ["bash", "str_replace_editor"], new Set(["grep"]))).toEqual([
      "bash",
      "str_replace_editor",
      "grep",
    ]);
  });

  it("omits unavailable extras and is idempotent in order", () => {
    _setConfigForTesting(config({ profile: "augmented", whitelist: ["todo", "missing"] }));
    const registered = new Set(["todo"]);
    const expected = ["bash", "str_replace_editor", "todo"];
    expect(desiredActiveTools(deepseek, expected, registered)).toBeNull();
    expect(desiredActiveTools(deepseek, ["todo", "bash", "str_replace_editor"], registered)).toEqual(expected);
  });

  it("is inert for non-minimal models and mode off", () => {
    expect(desiredActiveTools(model(), ["bash", "read", "tool_search"], new Set())).toBeNull();
    _setConfigForTesting(config({ mode: "off" }));
    expect(desiredActiveTools(deepseek, ["bash"], new Set())).toBeNull();
  });
});

describe("blocking policy", () => {
  it("strict blocks names outside the pair and delegates editor-owned names", () => {
    _setConfigForTesting(config());
    expect(shouldBlockTool("bash", deepseek)).toBe(false);
    expect(shouldBlockTool("str_replace_editor", deepseek)).toBe(false);
    expect(shouldBlockTool("ask_user", deepseek)).toBe(true);
    expect(shouldBlockTool("read", deepseek)).toBe(false);
    expect(shouldBlockTool("grep", deepseek)).toBe(true);
    expect(shouldBlockTool("find", deepseek)).toBe(true);
    expect(shouldBlockTool("ls", deepseek)).toBe(true);
  });

  it("augmented allows registered whitelist names only", () => {
    _setConfigForTesting(config({ profile: "augmented", whitelist: ["ask_user", "todo"] }));
    const registered = new Set(["ask_user"]);
    expect(shouldBlockTool("ask_user", deepseek, registered)).toBe(false);
    expect(shouldBlockTool("todo", deepseek, registered)).toBe(true);
    expect(shouldBlockTool("web_fetch", deepseek, registered)).toBe(true);
  });

  it("does not own calls for non-minimal models or mode off", () => {
    expect(shouldBlockTool("tool_search", model())).toBe(false);
    _setConfigForTesting(config({ mode: "off" }));
    expect(shouldBlockTool("ask_user", deepseek)).toBe(false);
  });
});
