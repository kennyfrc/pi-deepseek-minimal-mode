import { afterEach, describe, expect, it } from "vitest";
import { getReminders } from "@kennyfrc/pi-system-reminders";
import minimalModeExtension, { buildAgentsMdContent } from "../src/index.js";
import { DEFAULT_DEEPSEEK_PATTERNS, WHITELIST_ALL_SENTINEL, _setConfigForTesting, type MinimalModeConfig } from "../src/gate.js";
import { harnessTools } from "../src/harness-payload.js";

afterEach(() => {
  _setConfigForTesting(null);
});

const DEFAULT_ACTIVE = [
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
  "ask_user",
  "todo",
  "memo",
  "str_replace_editor",
];

function config(overrides: Partial<MinimalModeConfig> = {}): MinimalModeConfig {
  return {
    mode: "auto",
    profile: "strict",
    deepseekPatterns: DEFAULT_DEEPSEEK_PATTERNS,
    whitelist: [],
    ...overrides,
  };
}

interface FakeCtx {
  model?: { id?: string; provider?: string; name?: string; api?: string };
  mode?: string;
  hasUI?: boolean;
  ui?: { setStatus: (key: string, value: string | undefined) => void };
  cwd?: string;
}

interface CatalogTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface FakePi {
  registered: Array<{ name: string }>;
  handlers: Map<string, (event: any, ctx: any) => unknown>;
  activeTools: string[];
  catalog: CatalogTool[];
  getActiveTools(): string[];
  setActiveTools(next: string[]): void;
  registerTool(tool: { name: string }): void;
  getAllTools(): CatalogTool[];
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
}

function makeFakePi(active: string[], catalog: CatalogTool[] = []): FakePi {
  const pi: FakePi = {
    registered: [],
    handlers: new Map(),
    activeTools: [...active],
    catalog: [...catalog],
    getActiveTools: () => [...pi.activeTools],
    setActiveTools: (next) => {
      pi.activeTools = [...next];
    },
    registerTool: (tool) => pi.registered.push(tool),
    getAllTools: () => [...pi.catalog],
    on: (event, handler) => pi.handlers.set(event, handler),
  };
  return pi;
}

function fire(pi: FakePi, event: string, eventPayload: unknown, ctx: FakeCtx): unknown {
  return pi.handlers.get(event)?.(eventPayload, ctx);
}

function deepseekCtx(): FakeCtx {
  return {
    model: { id: "deepseek-v4-flash", provider: "neuralwatt", api: "openai-completions" },
    mode: "rpc",
    hasUI: true,
    ui: { setStatus: () => {} },
    cwd: process.cwd(),
  };
}

function glmCtx(): FakeCtx {
  return {
    model: { id: "glm-5.2-short", provider: "neuralwatt", api: "openai-completions" },
    mode: "rpc",
    hasUI: true,
    ui: { setStatus: () => {} },
    cwd: process.cwd(),
  };
}

function liveTool(name: string, marker: string) {
  return {
    type: "function",
    function: {
      name,
      description: `${name} live`,
      parameters: { type: "object", properties: { marker: { const: marker } } },
      provider_extension: marker,
    },
  };
}

describe("extension surface", () => {
  it("registers no tool and only the durable agents-md reminder", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    expect(pi.registered).toEqual([]);
    expect(getReminders(pi as never).map((reminder) => reminder.id)).toEqual(["agents-md"]);
    expect(getReminders(pi as never)[0].lifetime).toBe("durable");
    expect(getReminders(pi as never)[0].on).toBe("session:start");
  });

  it("keeps agents-md silent for strict and emits it for augmented", () => {
    _setConfigForTesting(config());
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    const reminder = getReminders(pi as never)[0];
    fire(pi, "session_start", {}, deepseekCtx());
    expect(reminder.content({ messages: [], contextFiles: [{ path: "/a/AGENTS.md", content: "# P" }] })).toBeNull();

    _setConfigForTesting(config({ profile: "augmented" }));
    fire(pi, "session_start", {}, deepseekCtx());
    expect(reminder.content({ messages: [], contextFiles: [{ path: "/a/AGENTS.md", content: "# P" }] })).toContain(
      "/a/AGENTS.md",
    );
  });

  it("dumps the registered whitelist extras into augmented agents content", () => {
    const catalog = [
      { name: "bash", description: "Run commands", parameters: { type: "object" } },
      { name: "str_replace_editor", description: "Edit files", parameters: { type: "object" } },
      { name: "ask_user", description: "Ask focused questions", parameters: { type: "object", properties: {} } },
    ];
    const pi = makeFakePi(DEFAULT_ACTIVE, catalog);
    minimalModeExtension(pi as never);
    const reminder = getReminders(pi as never)[0];
    _setConfigForTesting(config({ profile: "augmented", whitelist: ["todo", "ask_user"] }));
    fire(pi, "session_start", {}, deepseekCtx());
    const text = reminder.content({ messages: [], contextFiles: [{ path: "/a/AGENTS.md", content: "# P" }] }) as string;
    expect(text).toContain("<available_tools>");
    expect(text).toContain("<name>ask_user</name>");
    expect(text).toContain("<description>Ask focused questions</description>");
    expect(text).not.toContain("<name>todo</name>");
    expect(text).not.toContain("<name>bash</name>");
    expect(text).not.toContain("<name>str_replace_editor</name>");
  });

  it("serializes the sentinel-expanded tools after the skills block", () => {
    const catalog = [
      { name: "bash", description: "Run commands", parameters: { type: "object" } },
      { name: "str_replace_editor", description: "Edit files", parameters: { type: "object" } },
      { name: "read", description: "Read files", parameters: { type: "object" } },
      { name: "apply_patch", description: "Patch files (GPT only)", parameters: { type: "object" } },
      { name: "ask_user", description: "Ask focused questions", parameters: { type: "object", properties: {} } },
    ];
    const pi = makeFakePi(DEFAULT_ACTIVE, catalog);
    minimalModeExtension(pi as never);
    const reminder = getReminders(pi as never)[0];
    _setConfigForTesting(config({ profile: "augmented", whitelist: [WHITELIST_ALL_SENTINEL] }));
    fire(pi, "session_start", {}, deepseekCtx());
    const text = reminder.content({ messages: [], contextFiles: [{ path: "/a/AGENTS.md", content: "# P" }] }) as string;
    expect(text).toContain("<available_skills>");
    expect(text.indexOf("<available_skills>")).toBeLessThan(text.indexOf("<available_tools>"));
    expect(text).toContain("<name>ask_user</name>");
    // The swap-owned trio and the GPT-only apply_patch never dump.
    expect(text).not.toContain("<name>read</name>");
    expect(text).not.toContain("<name>apply_patch</name>");
    expect(text).not.toContain("<name>bash</name>");
  });

  it("keeps agents-md silent for non-minimal models and mode off", () => {
    _setConfigForTesting(config({ profile: "augmented" }));
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    const reminder = getReminders(pi as never)[0];
    fire(pi, "session_start", {}, glmCtx());
    expect(reminder.content({ messages: [], contextFiles: [{ path: "/a/AGENTS.md", content: "# P" }] })).toBeNull();
    _setConfigForTesting(config({ mode: "off", profile: "augmented" }));
    fire(pi, "session_start", {}, deepseekCtx());
    expect(reminder.content({ messages: [], contextFiles: [{ path: "/a/AGENTS.md", content: "# P" }] })).toBeNull();
  });
});

describe("active-tool lifecycle", () => {
  it("strict default collapses every sweep to the core pair", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    fire(pi, "session_start", {}, deepseekCtx());
    expect(pi.activeTools).toEqual(["bash", "str_replace_editor"]);
    pi.activeTools.push("mcp");
    fire(pi, "context", {}, deepseekCtx());
    expect(pi.activeTools).toEqual(["bash", "str_replace_editor"]);
  });

  it("augmented restores registered extras in config order after another gate removes them", () => {
    _setConfigForTesting(config({ profile: "augmented", whitelist: ["grep", "ask_user", "missing"] }));
    const pi = makeFakePi(DEFAULT_ACTIVE, [
      { name: "bash" },
      { name: "str_replace_editor" },
      { name: "grep" },
      { name: "ask_user" },
    ]);
    minimalModeExtension(pi as never);
    fire(pi, "session_start", {}, deepseekCtx());
    expect(pi.activeTools).toEqual(["bash", "str_replace_editor", "grep", "ask_user"]);

    pi.activeTools = ["bash", "str_replace_editor"];
    fire(pi, "turn_start", {}, deepseekCtx());
    expect(pi.activeTools).toEqual(["bash", "str_replace_editor", "grep", "ask_user"]);
  });

  it("picks up a late-registered whitelist tool on the next context sweep", () => {
    _setConfigForTesting(config({ profile: "augmented", whitelist: ["todo"] }));
    const pi = makeFakePi(DEFAULT_ACTIVE, [{ name: "bash" }, { name: "str_replace_editor" }]);
    minimalModeExtension(pi as never);
    fire(pi, "session_start", {}, deepseekCtx());
    expect(pi.activeTools).toEqual(["bash", "str_replace_editor"]);
    pi.catalog.push({ name: "todo" }, { name: "mcp" });
    fire(pi, "context", {}, deepseekCtx());
    expect(pi.activeTools).toEqual(["bash", "str_replace_editor", "todo"]);
  });

  it("is inert for non-minimal models and mode off", () => {
    const withForeignDiscovery = [...DEFAULT_ACTIVE, "tool_search"];
    const pi = makeFakePi(withForeignDiscovery);
    minimalModeExtension(pi as never);
    fire(pi, "session_start", {}, glmCtx());
    expect(pi.activeTools).toEqual(withForeignDiscovery);
    _setConfigForTesting(config({ mode: "off" }));
    fire(pi, "session_start", {}, deepseekCtx());
    expect(pi.activeTools).toEqual(withForeignDiscovery);
  });

  it("updates TUI status even when the active set needs no change", () => {
    _setConfigForTesting(config());
    const pi = makeFakePi(["bash", "str_replace_editor"]);
    minimalModeExtension(pi as never);
    const statuses: string[] = [];
    const strictCtx = {
      ...deepseekCtx(),
      mode: "tui",
      ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value ?? "") },
    };
    fire(pi, "session_start", {}, strictCtx);
    const offCtx = {
      ...glmCtx(),
      mode: "tui",
      ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value ?? "") },
    };
    fire(pi, "model_select", {}, offCtx);
    expect(statuses).toEqual(["minimal mode strict", "minimal mode off"]);
  });
});

describe("provider and call gates", () => {
  it("strict writes the frozen pair and preserves request parameters", () => {
    _setConfigForTesting(config());
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    const handler = pi.handlers.get("before_provider_request")!;
    const payload: Record<string, unknown> = {
      system: "pi",
      tools: [liveTool("bash", "b"), liveTool("str_replace_editor", "e"), liveTool("ask_user", "a")],
      store: false,
      max_completion_tokens: 1234,
      reasoning_effort: "medium",
      messages: [{ role: "user", content: "hello" }],
    };
    const projected = handler({ payload }, deepseekCtx()) as Record<string, unknown>;
    expect(projected.tools).toEqual(harnessTools());
    expect(projected.store).toBe(false);
    expect(projected.max_completion_tokens).toBe(1234);
    expect(projected.reasoning_effort).toBe("medium");
  });

  it("augmented inlines full live extra schemas in config order", () => {
    _setConfigForTesting(config({ profile: "augmented", whitelist: ["todo", "ask_user"] }));
    const pi = makeFakePi(DEFAULT_ACTIVE, [
      { name: "bash" },
      { name: "str_replace_editor" },
      { name: "ask_user" },
      { name: "todo" },
    ]);
    minimalModeExtension(pi as never);
    const bash = liveTool("bash", "b");
    const editor = liveTool("str_replace_editor", "e");
    const askUser = liveTool("ask_user", "a");
    const todo = liveTool("todo", "t");
    const payload = {
      system: "pi",
      tools: [askUser, liveTool("mcp", "m"), bash, todo, editor],
      messages: [{ role: "user", content: "hello" }],
    };
    const projected = pi.handlers.get("before_provider_request")!({ payload }, deepseekCtx()) as typeof payload;
    expect(projected.tools).toEqual([bash, editor, todo, askUser]);
    expect(projected.tools[2]).toBe(todo);
    expect(projected.tools[3]).toBe(askUser);
  });

  it("augmented rejects a registered extra whose provider schema is missing", () => {
    _setConfigForTesting(config({ profile: "augmented", whitelist: ["todo"] }));
    const pi = makeFakePi(DEFAULT_ACTIVE, [{ name: "bash" }, { name: "str_replace_editor" }, { name: "todo" }]);
    minimalModeExtension(pi as never);
    const payload = {
      system: "pi",
      tools: [liveTool("bash", "b"), liveTool("str_replace_editor", "e")],
      messages: [{ role: "user", content: "hello" }],
    };
    expect(() => pi.handlers.get("before_provider_request")!({ payload }, deepseekCtx())).toThrow(
      "registered augmented tool is missing from provider payload: todo",
    );
  });

  it("block guidance lists only direct tools", () => {
    _setConfigForTesting(config({ profile: "augmented", whitelist: ["ask_user"] }));
    const pi = makeFakePi(DEFAULT_ACTIVE, [{ name: "ask_user" }]);
    minimalModeExtension(pi as never);
    const handler = pi.handlers.get("tool_call")!;
    const blocked = handler({ toolName: "web_fetch" }, deepseekCtx()) as { block: boolean; reason: string };
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("bash, str_replace_editor, ask_user");
    expect(blocked.reason).not.toContain("discover");
    expect(handler({ toolName: "ask_user" }, deepseekCtx())).toBeUndefined();
    expect(handler({ toolName: "read" }, deepseekCtx())).toBeUndefined();
    expect(handler({ toolName: "web_fetch" }, glmCtx())).toBeUndefined();
  });
});

describe("agents content", () => {
  it("puts context files before available skills", () => {
    const skills = [{ name: "web-animations", description: "Motion", filePath: "/s/SKILL.md" }] as never;
    const text = buildAgentsMdContent([{ path: "/a/AGENTS.md", content: "# P" }], skills)!;
    expect(text).toContain("/a/AGENTS.md");
    expect(text).toContain("<available_skills>");
    expect(text.indexOf("/a/AGENTS.md")).toBeLessThan(text.indexOf("<available_skills>"));
  });

  it("excludes disableModelInvocation skills and returns null for empty input", () => {
    const skills = [
      { name: "visible", description: "d", filePath: "/v/SKILL.md" },
      { name: "hidden", description: "d", filePath: "/h/SKILL.md", disableModelInvocation: true },
    ] as never;
    const text = buildAgentsMdContent([], skills)!;
    expect(text).toContain("<name>visible</name>");
    expect(text).not.toContain("<name>hidden</name>");
    expect(buildAgentsMdContent([], [])).toBeNull();
  });

  it("serializes extra tools after the skills block with their schemas", () => {
    const skills = [{ name: "web-animations", description: "Motion", filePath: "/s/SKILL.md" }] as never;
    const tools = [
      { name: "ask_user", description: "Ask focused questions", parameters: { type: "object", properties: {} } },
      { name: "todo", description: "Manage todo list", parameters: { type: "object", properties: {} } },
    ];
    const text = buildAgentsMdContent([{ path: "/a/AGENTS.md", content: "# P" }], skills, tools)!;
    expect(text).toContain("<available_tools>");
    expect(text).toContain("<name>ask_user</name>");
    expect(text).toContain("<description>Ask focused questions</description>");
    expect(text).toContain('{"type":"object","properties":{}}');
    expect(text).toContain("<name>todo</name>");
    expect(text.indexOf("/a/AGENTS.md")).toBeLessThan(text.indexOf("<available_skills>"));
    expect(text.indexOf("<available_skills>")).toBeLessThan(text.indexOf("<available_tools>"));
    expect(text.indexOf("<name>ask_user</name>")).toBeLessThan(text.indexOf("<name>todo</name>"));
  });

  it("escapes XML in tool text and omits the block when tools are empty", () => {
    const tools = [{ name: "ask_user", description: "a < b & c > d", parameters: { enum: [1, "<"] } }];
    const text = buildAgentsMdContent([], [], tools)!;
    expect(text).toContain("&lt;");
    expect(text).not.toContain("a < b");
    expect(buildAgentsMdContent([], [], [])).toBeNull();
  });

  it("emits the available_tools block without skills or files present", () => {
    const tools = [{ name: "memo", description: "Workspace memory", parameters: { type: "object" } }];
    const text = buildAgentsMdContent([], [], tools)!;
    expect(text).toContain("<available_tools>");
    expect(text).toContain("<name>memo</name>");
  });
});
