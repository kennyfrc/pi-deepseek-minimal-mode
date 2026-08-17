/**
 * Gate tests: deepseek detection, minimal active set computation,
 * tool_search-only ownership for non-minimal models, and the blocking matrix.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEEPSEEK_PATTERNS,
  DEFAULT_WHITELIST,
  MINIMAL_CORE_TOOLS,
  desiredActiveTools,
  isDeepSeekModel,
  isMinimalActive,
  shouldBlockTool,
  _setConfigForTesting,
  type GatableModel,
} from "../src/gate.js";

afterEach(() => {
  _setConfigForTesting(null);
});

const FULL_ACTIVE = [
  "bash",
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "cdp",
  "flows",
  "ask_user",
  "todo",
  "memo",
  "str_replace_editor",
  "some_extension_tool",
];

function model(overrides: Partial<GatableModel> = {}): GatableModel {
  return { id: "glm-5.2-short", provider: "neuralwatt", api: "openai-completions", ...overrides };
}

describe("isDeepSeekModel", () => {
  it("matches deepseek in id, provider, or name, case-insensitively", () => {
    expect(isDeepSeekModel(model({ id: "deepseek-v4-flash" }))).toBe(true);
    expect(isDeepSeekModel(model({ id: "DeepSeek-V4-Pro" }))).toBe(true);
    expect(isDeepSeekModel(model({ provider: "deepseek", id: "v4" }))).toBe(true);
    expect(isDeepSeekModel(model({ id: "x", name: "DeepSeek V4 Flash" }))).toBe(true);
  });

  it("rejects unrelated models and missing models", () => {
    expect(isDeepSeekModel(model())).toBe(false);
    expect(isDeepSeekModel(undefined)).toBe(false);
    expect(isDeepSeekModel(null)).toBe(false);
  });

  it("uses configured patterns instead of the default when provided", () => {
    _setConfigForTesting({ mode: "auto", deepseekPatterns: [/^ds-/i], whitelist: DEFAULT_WHITELIST });
    expect(isDeepSeekModel(model({ id: "ds-r1-0528" }))).toBe(true);
    expect(isDeepSeekModel(model({ id: "deepseek-v4-flash" }))).toBe(false);
  });
});

describe("isMinimalActive", () => {
  it("auto: active only for deepseek", () => {
    _setConfigForTesting({ mode: "auto", deepseekPatterns: DEFAULT_DEEPSEEK_PATTERNS, whitelist: DEFAULT_WHITELIST });
    expect(isMinimalActive(model({ id: "deepseek-v4-flash" }))).toBe(true);
    expect(isMinimalActive(model())).toBe(false);
  });

  it("on: active for every model; off: active for none", () => {
    _setConfigForTesting({ mode: "on", deepseekPatterns: DEFAULT_DEEPSEEK_PATTERNS, whitelist: DEFAULT_WHITELIST });
    expect(isMinimalActive(model())).toBe(true);
    _setConfigForTesting({ mode: "off", deepseekPatterns: DEFAULT_DEEPSEEK_PATTERNS, whitelist: DEFAULT_WHITELIST });
    expect(isMinimalActive(model({ id: "deepseek-v4-flash" }))).toBe(false);
  });
});

describe("desiredActiveTools", () => {
  it("deepseek: collapses the set to core tools + whitelist, preserves nothing else", () => {
    const next = desiredActiveTools(model({ id: "deepseek-v4-flash" }), FULL_ACTIVE);
    // Exactly the harness minimal pair plus the tool_search discovery channel.
    expect([...next!].sort()).toEqual([...MINIMAL_CORE_TOOLS].sort());
    expect(next).not.toContain("read");
    expect(next).not.toContain("web_fetch");
    expect(next).not.toContain("cdp");
    expect(next).not.toContain("ask_user");
  });

  it("deepseek: whitelist tools are kept only when already active (never force-added)", () => {
    const next = desiredActiveTools(model({ id: "deepseek-v4-flash" }), [
      "bash",
      "str_replace_editor",
      "tool_search",
      "some_extension_tool",
    ]);
    // Not whitelisted by default -> dropped.
    expect(next).toEqual(["bash", "str_replace_editor", "tool_search"]);
  });

  it("deepseek: ensures the core tools are present even when missing from the active set", () => {
    const next = desiredActiveTools(model({ id: "deepseek-v4-flash" }), ["bash"]);
    expect(next).toEqual(["bash", "str_replace_editor", "tool_search"]);
  });

  it("non-deepseek: removes tool_search, touches nothing else", () => {
    const next = desiredActiveTools(model(), ["bash", "read", "edit", "write", "tool_search", "cdp"]);
    expect(next).toEqual(["bash", "read", "edit", "write", "cdp"]);
  });

  it("non-deepseek without the discovery tools: no-op (null)", () => {
    expect(desiredActiveTools(model(), ["bash", "read", "edit", "write", "cdp"])).toBeNull();
  });

  it("mode off: inert", () => {
    _setConfigForTesting({ mode: "off", deepseekPatterns: DEFAULT_DEEPSEEK_PATTERNS, whitelist: DEFAULT_WHITELIST });
    expect(desiredActiveTools(model({ id: "deepseek-v4-flash" }), FULL_ACTIVE)).toBeNull();
    expect(desiredActiveTools(model(), ["bash", "tool_search"])).toBeNull();
  });

  it("is idempotent: returns null when the set is already correct", () => {
    expect(desiredActiveTools(model({ id: "deepseek-v4-flash" }), [...MINIMAL_CORE_TOOLS])).toBeNull();
    expect(desiredActiveTools(model(), ["bash", "read"])).toBeNull();
  });

  it("custom whitelist keeps extra tools for deepseek (e.g. always-on web_search)", () => {
    _setConfigForTesting({
      mode: "auto",
      deepseekPatterns: DEFAULT_DEEPSEEK_PATTERNS,
      whitelist: ["cdp", "web_search"],
    });
    const next = desiredActiveTools(model({ id: "deepseek-v4-flash" }), ["bash", "cdp", "web_search", "web_fetch"]);
    expect([...next!].sort()).toEqual(["bash", "cdp", "str_replace_editor", "tool_search", "web_search"].sort());
  });

  it("tools discovered via tool_search survive the gate", () => {
    const discovered = new Set(["web_search", "web_fetch"]);
    const next = desiredActiveTools(model({ id: "deepseek-v4-flash" }), [
      "bash",
      "str_replace_editor",
      "tool_search",
      "web_search",
      "web_fetch",
      "cdp",
    ], discovered);
    expect([...next!].sort()).toEqual(["bash", "str_replace_editor", "tool_search", "web_fetch", "web_search"].sort());
    // Idempotent with the discovered set present.
    expect(desiredActiveTools(model({ id: "deepseek-v4-flash" }), next!, discovered)).toBeNull();
  });
});

describe("blocking matrix", () => {
  it("minimal model: blocks everything outside the allowed set, never read/edit/write/grep/find/ls", () => {
    const deepseek = model({ id: "deepseek-v4-flash" });
    expect(shouldBlockTool("web_fetch", deepseek)).toBe(true);
    expect(shouldBlockTool("cdp", deepseek)).toBe(true);
    expect(shouldBlockTool("flows", deepseek)).toBe(true);
    expect(shouldBlockTool("web_search", deepseek)).toBe(true); // hidden until discovered
    expect(shouldBlockTool("ask_user", deepseek)).toBe(true);
    expect(shouldBlockTool("bash", deepseek)).toBe(false);
    expect(shouldBlockTool("str_replace_editor", deepseek)).toBe(false);
    expect(shouldBlockTool("tool_search", deepseek)).toBe(false);
    // Discovered tools are not blocked.
    expect(shouldBlockTool("web_fetch", deepseek, new Set(["web_fetch"]))).toBe(false);
    // Owned by pi-str-replace-editor's blocks with better messages.
    expect(shouldBlockTool("read", deepseek)).toBe(false);
    expect(shouldBlockTool("edit", deepseek)).toBe(false);
    expect(shouldBlockTool("write", deepseek)).toBe(false);
    expect(shouldBlockTool("grep", deepseek)).toBe(false);
    expect(shouldBlockTool("find", deepseek)).toBe(false);
    expect(shouldBlockTool("ls", deepseek)).toBe(false);
  });

  it("non-minimal model: blocks tool_search only", () => {
    const glm = model();
    expect(shouldBlockTool("tool_search", glm)).toBe(true);
    expect(shouldBlockTool("web_fetch", glm)).toBe(false);
    expect(shouldBlockTool("cdp", glm)).toBe(false);
  });

  it("mode off: blocks nothing", () => {
    _setConfigForTesting({ mode: "off", deepseekPatterns: DEFAULT_DEEPSEEK_PATTERNS, whitelist: DEFAULT_WHITELIST });
    expect(shouldBlockTool("cdp", model({ id: "deepseek-v4-flash" }))).toBe(false);
    expect(shouldBlockTool("tool_search", model())).toBe(false);
  });
});
