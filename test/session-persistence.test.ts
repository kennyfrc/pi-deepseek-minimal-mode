/** Cross-package integration for augmented durable context and strict scrub. */
import { describe, expect, it } from "vitest";
import { convertToLlm } from "@earendil-works/pi-agent-core";
import { registerReminder, SYSTEM_REMINDER_CUSTOM_TYPE } from "@kennyfrc/pi-system-reminders";
import type { MinimalModeConfig } from "../src/gate.js";
import { projectMinimalPayload } from "../src/harness-payload.js";

interface Entry {
  parentId: string | null;
  type: string;
  customType?: string;
  details?: unknown;
}
type StateMessage = { role: string; content: unknown; customType?: string; timestamp: number };

const augmented: MinimalModeConfig = {
  mode: "auto",
  profile: "augmented",
  deepseekPatterns: [/deepseek/i],
  whitelist: [],
};
const strict: MinimalModeConfig = { ...augmented, profile: "strict" };

function makeRuntime() {
  const state: StateMessage[] = [];
  const entries = new Map<string, Entry>();
  let leafId: string | null = null;
  let nextId = 1;
  const sentMessages: unknown[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
    sendMessage: async (message: { customType: string; content: unknown; display: boolean; details?: unknown }) => {
      sentMessages.push(message);
      state.push({ role: "custom", ...message, timestamp: Date.now() } as StateMessage);
      const id = `e${nextId++}`;
      entries.set(id, {
        parentId: leafId,
        type: "custom_message",
        customType: message.customType,
        details: message.details,
      });
      leafId = id;
    },
  };
  const ctx = { sessionManager: { getLeafId: () => leafId, getEntry: (id: string) => entries.get(id) } };
  const appendPrompt = (role: "user" | "assistant", text: string) => {
    state.push({ role, content: [{ type: "text", text }], timestamp: Date.now() } as StateMessage);
    const id = `e${nextId++}`;
    entries.set(id, { parentId: leafId, type: "message" });
    leafId = id;
  };
  return { state, sentMessages, handlers, ctx, pi, appendPrompt };
}

function boot(pi: unknown) {
  registerReminder(pi as never, {
    id: "agents-md",
    label: "agents-md",
    lifetime: "durable",
    on: "session:start",
    content: (context: { contextFiles?: unknown[] }) =>
      context.contextFiles ? "path/AGENTS.md:\nAGENTS.md content: always run tests.\n\nskills: web-animations..." : null,
  } as never);
  registerReminder(pi as never, {
    id: "flows",
    label: "flows",
    lifetime: "transient",
    on: "turn:start",
    content: () => "flows trigger noise",
  } as never);
}

const FILES = [{ path: "path/AGENTS.md", content: "AGENTS.md content: always run tests." }];

describe("augmented durable context and strict resume scrub", () => {
  it("persists only agents-md in augmented and strips every reminder in strict", async () => {
    const runtime = makeRuntime();
    boot(runtime.pi);

    const firePrompt = async (text: string, profile: MinimalModeConfig) => {
      await runtime.handlers.get("before_agent_start")!({ systemPromptOptions: { contextFiles: FILES } }, runtime.ctx);
      runtime.appendPrompt("user", text);
      const output = (await runtime.handlers.get("context")!({ messages: structuredClone(runtime.state) }, {})) as
        | { messages: StateMessage[] }
        | undefined;
      const llm = convertToLlm((output?.messages ?? runtime.state) as never[]);
      const preProjection = llm.map((message) => ({
        role: message.role,
        content: (message.content as Array<{ text: string }>).map((part) => part.text).join(""),
      }));
      const payload = {
        system: "full pi system prompt",
        tools: [{ name: "bash" }, { name: "str_replace_editor" }],
        messages: preProjection.map((message) => ({ ...message })),
      };
      projectMinimalPayload(payload, profile);
      return { payload, preProjection };
    };

    const wire1 = await firePrompt("first task", augmented);
    runtime.appendPrompt("assistant", "done");
    const wire2 = await firePrompt("second task", augmented);
    const strictResume = await firePrompt("strict resume", strict);
    const has = (messages: Array<{ role: string; content: string }>, needle: string) =>
      messages.some((message) => message.content.includes(needle));

    expect(wire1.payload.messages[0].content).toContain('<reminder type="agents-md" durable="true">');
    expect(wire1.payload.messages[0].content).not.toContain("tool-search");
    expect(has(wire2.payload.messages, "AGENTS.md content")).toBe(true);
    expect(has(wire2.preProjection, "flows trigger noise")).toBe(true);
    expect(has(wire2.payload.messages, "flows trigger noise")).toBe(false);
    expect(strictResume.payload.messages.some((message) => message.content.includes("<system_reminder>"))).toBe(false);

    const durableBlocks = runtime.state.filter(
      (message) => message.role === "custom" && message.customType === SYSTEM_REMINDER_CUSTOM_TYPE,
    );
    expect(durableBlocks).toHaveLength(1);
    expect(runtime.sentMessages).toHaveLength(1);
    expect(runtime.state[0].role).toBe("custom");
    expect((runtime.state[1].content as Array<{ text: string }>)[0].text).toBe("first task");
  });
});
