/**
 * Extension wiring tests: tool_search registration, gating application on
 * session_start/model_select, tool_call blocking, and the turn:start reminder
 * (registered via pi-system-reminders, fires only while minimal is active).
 */
import { afterEach, describe, expect, it } from "vitest";
import minimalModeExtension, { buildAgentsMdContent } from "../src/index.js";
import { _setConfigForTesting } from "../src/gate.js";
import { harnessTools } from "../src/harness-payload.js";
import { getReminders } from "@kennyfrc/pi-system-reminders";

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

interface FakeCtx {
  model?: { id?: string; provider?: string; name?: string; api?: string };
  mode?: string;
  hasUI?: boolean;
  ui?: { setStatus: () => void };
  cwd?: string;
}

interface FakePi {
  registered: Array<{ name: string }>;
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  activeTools: string[];
  getActiveTools(): string[];
  setActiveTools(next: string[]): void;
  registerTool(tool: { name: string }): void;
  getAllTools(): Array<{ name: string }>;
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
}

function makeFakePi(active: string[]): FakePi {
  const pi: FakePi = {
    registered: [],
    handlers: new Map(),
    activeTools: [...active],
    getActiveTools: () => [...pi.activeTools],
    setActiveTools: (next) => {
      pi.activeTools = next;
    },
    registerTool: (tool) => {
      pi.registered.push(tool);
    },
    getAllTools: () => [],
    on: (event, handler) => {
      pi.handlers.set(event, handler);
    },
  };
  return pi;
}

function fire(pi: FakePi, event: string, eventPayload: unknown, ctx: FakeCtx): unknown {
  return pi.handlers.get(event)?.(eventPayload, ctx);
}

function deepseekCtx(): FakeCtx {
  return { model: { id: "deepseek-v4-flash", provider: "neuralwatt", api: "openai-completions" }, mode: "rpc", hasUI: true, ui: { setStatus: () => {} } };
}

function glmCtx(): FakeCtx {
  return { model: { id: "glm-5.2-short", provider: "neuralwatt", api: "openai-completions" }, mode: "rpc", hasUI: true, ui: { setStatus: () => {} } };
}

describe("pi-deepseek-minimal-mode wiring", () => {
  it("registers no WebSearch tool: pi's web_search/web_fetch are the only search surface", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    expect(pi.registered.map((tool) => tool.name)).not.toContain("WebSearch");
    expect(pi.registered.map((tool) => tool.name)).toContain("tool_search");
  });

  it("registers the tool_search discovery channel", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    expect(pi.registered.map((tool) => tool.name)).toContain("tool_search");
  });

  it("registers NO transient turn:start reminder (clean RL first request)", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    const reminders = getReminders(pi as never);
    expect(reminders.find((r) => r.id === "minimal-mode")).toBeUndefined();
    // The only sanctioned injections are the two durable session:start
    // reminders: agents-md and the one-shot tool-search nudge.
    expect(reminders.map((r) => r.id)).toEqual(["agents-md", "tool-search"]);
  });

  it("deepseek session_start: collapses to bash + str_replace_editor + tool_search", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    fire(pi, "session_start", {}, deepseekCtx());
    expect([...pi.activeTools].sort()).toEqual(["bash", "str_replace_editor", "tool_search"].sort());
  });

  it("glm session_start: removes tool_search only", () => {
    const pi = makeFakePi([...DEFAULT_ACTIVE, "tool_search"]);
    minimalModeExtension(pi as never);
    fire(pi, "session_start", {}, glmCtx());
    expect(pi.activeTools).toEqual(DEFAULT_ACTIVE);
  });

  it("registers NO transient contract reminder: the wire stays a clean RL first request", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    const reminders = getReminders(pi as never);
    expect(reminders.find((r) => r.id === "minimal-mode")).toBeUndefined();
    // The only sanctioned injections are the two durable session:start
    // reminders: agents-md and the one-shot tool-search nudge.
    expect(reminders.map((r) => r.id)).toEqual(["agents-md", "tool-search"]);
  });

  it("registers a durable session:start reminder carrying the context files", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    const reminders = getReminders(pi as never);
    const agentsMd = reminders.find((r) => r.id === "agents-md");
    expect(agentsMd).toBeDefined();
    expect(agentsMd?.lifetime).toBe("durable");
    expect(agentsMd?.on).toBe("session:start");
    // Silent without files or for non-minimal models; renders path + content.
    expect(agentsMd?.content({ messages: [], contextFiles: [] })).toBeNull();
    fire(pi, "session_start", {}, glmCtx()); // currentModel = glm
    expect(agentsMd?.content({ messages: [], contextFiles: [{ path: "/a/AGENTS.md", content: "# P" }] })).toBeNull();
    fire(pi, "session_start", {}, deepseekCtx());
    expect(agentsMd?.content({ messages: [], contextFiles: [{ path: "/a/AGENTS.md", content: "# P" }] })).toContain("/a/AGENTS.md");
  });

  it("buildAgentsMdContent: context files first, then the available-skills block", () => {
    const skills = [
      { name: "web-animations", description: "Motion playbook", filePath: "/s/web/SKILL.md" },
    ] as never;
    const text = buildAgentsMdContent([{ path: "/a/AGENTS.md", content: "# P" }], skills);
    expect(text).toContain("/a/AGENTS.md");
    expect(text).toContain("<available_skills>");
    expect(text).toContain("<name>web-animations</name>");
    expect(text).toContain("<description>Motion playbook</description>");
    expect(text).toContain("<location>/s/web/SKILL.md</location>");
    // Files come first, skills after.
    expect(text!.indexOf("/a/AGENTS.md")).toBeLessThan(text!.indexOf("<available_skills>"));
  });

  it("buildAgentsMdContent: skills-only renders the block; empty input renders null", () => {
    const skills = [{ name: "s", description: "d", filePath: "/s/SKILL.md" }] as never;
    expect(buildAgentsMdContent([], skills)).toContain("<available_skills>");
    expect(buildAgentsMdContent([], [])).toBeNull();
  });

  it("buildAgentsMdContent: disableModelInvocation skills stay excluded (pi formatter semantics)", () => {
    const skills = [
      { name: "visible", description: "d", filePath: "/v/SKILL.md" },
      { name: "hidden", description: "d", filePath: "/h/SKILL.md", disableModelInvocation: true },
    ] as never;
    const text = buildAgentsMdContent([], skills);
    expect(text).toContain("<name>visible</name>");
    expect(text).not.toContain("<name>hidden</name>");
  });

  it("agents-md content: PI_MINIMAL_SKILLS=0 keeps the block to context files only", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    const agentsMd = getReminders(pi as never).find((r) => r.id === "agents-md");
    fire(pi, "session_start", {}, deepseekCtx());
    const prev = process.env.PI_MINIMAL_SKILLS;
    process.env.PI_MINIMAL_SKILLS = "0";
    try {
      const text = agentsMd?.content({ messages: [], contextFiles: [{ path: "/a/AGENTS.md", content: "# P" }] });
      expect(text).toContain("/a/AGENTS.md");
      expect(text).not.toContain("<available_skills>");
    } finally {
      if (prev === undefined) delete process.env.PI_MINIMAL_SKILLS;
      else process.env.PI_MINIMAL_SKILLS = prev;
    }
  });

  it("registers the durable tool-search nudge: fires once at the first prompt, deepseek only", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    const nudge = getReminders(pi as never).find((r) => r.id === "tool-search");
    expect(nudge).toBeDefined();
    expect(nudge?.lifetime).toBe("durable");
    expect(nudge?.on).toBe("session:start");
    // Non-minimal model: silent.
    fire(pi, "session_start", {}, glmCtx());
    expect(nudge?.content({ messages: [] })).toBeNull();
    // Minimal model: the nudge text, delivered as a system_reminder block
    // adjacent to the first user prompt by pi-system-reminders.
    fire(pi, "session_start", {}, deepseekCtx());
    const text = nudge?.content({ messages: [] });
    expect(text).toContain("tool_search");
    expect(text).toContain('"query"');
    expect(text).toContain("Prefer an existing tool over raw bash exploration");
  });

  it("tool_search activation: found tools enter the active set and survive the sweeps", async () => {
    const pi = makeFakePi(["bash", "str_replace_editor", "tool_search"]);
    pi.getAllTools = () => [
      { name: "bash", description: "Run shell commands." },
      { name: "str_replace_editor", description: "View and edit files." },
      { name: "tool_search", description: "Find tools." },
      { name: "web_search", description: "Search the current web." },
      { name: "web_fetch", description: "Read a URL." },
    ] as never;
    minimalModeExtension(pi as never);
    fire(pi, "session_start", {}, deepseekCtx());

    const tool = pi.registered.find((t) => t.name === "tool_search") as unknown as {
      execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
    };
    const result = await tool.execute("id", { query: "search the web", limit: 1 }, undefined, () => {}, deepseekCtx());
    expect(result.content[0].text).toContain("web_search");
    expect(result.content[0].text).toContain("Call these tools by name");
    expect(pi.activeTools).toContain("web_search");

    // The turn_start/context sweeps must keep the discovered tool.
    fire(pi, "turn_start", {}, deepseekCtx());
    expect(pi.activeTools).toContain("web_search");
    expect(pi.activeTools).toContain("str_replace_editor");
    // A second search does not duplicate entries.
    await tool.execute("id2", { query: "web" }, undefined, () => {}, deepseekCtx());
    expect(pi.activeTools.filter((n) => n === "web_search")).toHaveLength(1);
  });

  it("blocks non-allowed tools for deepseek with a pointer at the allowed set", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    fire(pi, "session_start", {}, deepseekCtx());
    const handler = pi.handlers.get("tool_call") as (event: { toolName: string; input: unknown }, ctx: unknown) => { block?: boolean; reason?: string } | undefined;
    const blocked = handler({ toolName: "web_fetch", input: {} }, deepseekCtx());
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("minimal mode");
    expect(blocked?.reason).toContain("bash");
    expect(blocked?.reason).toContain("tool_search");
    expect(handler({ toolName: "bash", input: {} }, deepseekCtx())).toBeUndefined();
    expect(handler({ toolName: "str_replace_editor", input: {} }, deepseekCtx())).toBeUndefined();
    expect(handler({ toolName: "tool_search", input: {} }, deepseekCtx())).toBeUndefined();
    // Hidden until discovered -> blocked with the same pointer.
    expect(handler({ toolName: "web_search", input: {} }, deepseekCtx())?.block).toBe(true);
    // str-replace-owned names are left to that extension's blocks.
    expect(handler({ toolName: "read", input: {} }, deepseekCtx())).toBeUndefined();
  });

  it("blocks tool_search for non-deepseek with a pointer at the full toolset", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    const handler = pi.handlers.get("tool_call") as (event: { toolName: string; input: unknown }, ctx: unknown) => { block?: boolean; reason?: string } | undefined;
    const blocked = handler({ toolName: "tool_search", input: {} }, glmCtx());
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("minimal mode");
    expect(handler({ toolName: "web_fetch", input: {} }, glmCtx())).toBeUndefined();
  });

  it("projects the provider payload onto the harness minimal reference", () => {
    const pi = makeFakePi(DEFAULT_ACTIVE);
    pi.getAllTools = () => [
      { name: "bash" },
      { name: "str_replace_editor" },
      { name: "tool_search" },
      { name: "web_search" },
      { name: "mcp" },
      { name: "read" },
    ] as never;
    minimalModeExtension(pi as never);
    fire(pi, "session_start", {}, deepseekCtx());
    const handler = pi.handlers.get("before_provider_request") as (
      event: { payload: Record<string, unknown> },
      ctx: unknown,
    ) => unknown;
    const piBashEntry = { type: "function", function: { name: "bash", description: "pi bash", parameters: { type: "object" } } };
    const piEditorEntry = { type: "function", function: { name: "str_replace_editor", description: "pi editor", parameters: { type: "object" } } };
    const payload: Record<string, unknown> = {
      model: "deepseek-ai/DeepSeek-V4-Flash",
      tools: [
        piBashEntry,
        { type: "function", function: { name: "mcp" } },
        { name: "read" },
        { name: "web_search" },
        piEditorEntry,
        { name: "tool_search" },
        { something: "else" },
      ],
      system: "You are Pi...\nAvailable tools:\n- bash: ...\n- tool_search: ...",
      store: false,
      max_completion_tokens: 16384,
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "System.\n- mcp: MCP gateway.\n" },
        { role: "user", content: "hi" },
      ],
    };
    // glm: not minimal -> handler returns nothing.
    expect(handler({ payload }, glmCtx())).toBeUndefined();
    const projected = handler({ payload }, deepseekCtx()) as Record<string, any>;
    // Tools: exactly pi's live bash + str_replace_editor entries, verbatim.
    const tools = projected.tools as unknown[];
    expect(tools).toEqual([piBashEntry, piEditorEntry]);
    // System: the harness persona replaces pi's prompt entirely.
    expect(projected.system).toBe("You are a helpful software engineer assistant.");
    expect(projected.messages?.[0]?.content).toBe("You are a helpful software engineer assistant.");
    expect(projected.messages?.[1]?.content).toBe("hi");
    // Harness-absent request keys are dropped; wire params match exactly.
    expect(projected.store).toBeUndefined();
    expect(projected.max_completion_tokens).toBeUndefined();
    expect(projected.reasoning_effort).toBe("high");
    expect(projected.thinking).toEqual({ type: "enabled" });
    expect(projected.max_tokens).toBe(65536);
  });

  it("discovered tools stay out of the payload too, but remain callable", async () => {
    const pi = makeFakePi(["bash", "str_replace_editor", "tool_search"]);
    pi.getAllTools = () => [
      { name: "bash", description: "Run shell commands." },
      { name: "str_replace_editor", description: "View and edit files." },
      { name: "tool_search", description: "Find tools." },
      { name: "web_search", description: "Search the current web.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    ] as never;
    minimalModeExtension(pi as never);
    fire(pi, "session_start", {}, deepseekCtx());

    const tool = pi.registered.find((t) => t.name === "tool_search") as unknown as {
      execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
    };
    await tool.execute("id", { query: "web" }, undefined, () => {}, deepseekCtx());
    expect(pi.activeTools).toContain("web_search"); // callable by name

    const handler = pi.handlers.get("before_provider_request") as (
      event: { payload: Record<string, unknown> },
      ctx: unknown,
    ) => unknown;
    const payload = {
      tools: [
        { type: "function", function: { name: "bash", parameters: {} } },
        { type: "function", function: { name: "str_replace_editor", parameters: {} } },
        { type: "function", function: { name: "tool_search", parameters: {} } },
        { type: "function", function: { name: "web_search", parameters: {} } },
      ],
      messages: [{ role: "system", content: "- web_search: Search web." }],
    };
    const result = handler({ payload }, deepseekCtx()) as { tools: Array<{ function?: { name?: string } }>; messages: Array<{ content: string }> };
    expect(result.tools.map((t) => t.function?.name)).toEqual(["bash", "str_replace_editor"]);
    // Live pi entries preserved verbatim (the same objects, not fixtures).
    expect(result.tools[0]).toEqual({ type: "function", function: { name: "bash", parameters: {} } });
    expect(result.tools[1]).toEqual({ type: "function", function: { name: "str_replace_editor", parameters: {} } });
    expect(result.messages[0].content).toBe("You are a helpful software engineer assistant.");
    // The discovered tool survives the sweep and stays callable.
    fire(pi, "turn_start", {}, deepseekCtx());
    expect(pi.activeTools).toContain("web_search");
  });

  it("mode off disables gating and blocking", () => {
    _setConfigForTesting({ mode: "off", deepseekPatterns: [/deepseek/i], whitelist: [] });
    const pi = makeFakePi(DEFAULT_ACTIVE);
    minimalModeExtension(pi as never);
    fire(pi, "session_start", {}, deepseekCtx());
    expect(pi.activeTools).toEqual(DEFAULT_ACTIVE);
    const handler = pi.handlers.get("tool_call") as (event: { toolName: string; input: unknown }, ctx: unknown) => { block?: boolean } | undefined;
    expect(handler({ toolName: "web_fetch", input: {} }, deepseekCtx())).toBeUndefined();
    const reminder = getReminders(pi as never).find((r) => r.id === "agents-md");
    expect(reminder?.content({ messages: [], contextFiles: [{ path: "/a/AGENTS.md", content: "# P" }] })).toBeNull();
  });
});
