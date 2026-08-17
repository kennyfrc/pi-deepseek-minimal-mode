/**
 * Cross-package integration: the durable reminder pair PERSISTS across a
 * whole session and keeps the required wire shape.
 *
 * Simulates pi's verified runtime mechanics over the REAL delivery stack —
 * registerReminder's before_agent_start sender, applyReminders (context
 * path), the REAL convertToLlm from @earendil-works/pi-agent-core, and the
 * REAL projectMinimalPayload:
 *
 * - sendMessage at idle with triggerTurn:false appends to state.messages and
 *   persists a custom_message entry parented at the leaf (agent-session.ts
 *   sendCustomMessage); the following user prompt is appended by runAgentLoop
 *   ([...state.messages, ...prompts]).
 * - the context event receives a structuredClone of state (emitContext).
 *
 * Contract verified: the agents-md + tool-search block is sent exactly once
 * (before the session's first user prompt), serializes to a USER-role
 * message wrapped in the same <system_reminder> envelope as transient
 * blocks, carries durable="true" markers, replays in every later request
 * (turn 2, turn 5) and on resume, survives the deepseek wire filter, while
 * other extensions' transient traffic stays per-turn and gets stripped.
 */
import { describe, expect, it } from "vitest";
import { convertToLlm } from "@earendil-works/pi-agent-core";
import { registerReminder, SYSTEM_REMINDER_CUSTOM_TYPE } from "@kennyfrc/pi-system-reminders";
import { projectMinimalPayload } from "../src/harness-payload.js";

interface Entry { parentId: string | null; type: string; customType?: string }
type StateMessage = { role: string; content: unknown; customType?: string; timestamp: number };

function makeRuntime() {
  const state: StateMessage[] = [];
  const entries = new Map<string, Entry>();
  let leafId: string | null = null;
  let nextId = 1;
  const sentMessages: unknown[] = [];
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
  const pi = {
    on: (ev: string, h: (e: unknown, c: unknown) => Promise<unknown>) => handlers.set(ev, h),
    sendMessage: async (message: { customType: string; content: unknown; display: boolean; details?: unknown }) => {
      sentMessages.push(message);
      state.push({ role: "custom", ...message, timestamp: Date.now() } as StateMessage);
      const id = `e${nextId++}`;
      entries.set(id, { parentId: leafId, type: "custom_message", customType: message.customType });
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
  // The two durable reminders pi-deepseek-minimal-mode registers.
  registerReminder(pi as never, {
    id: "agents-md",
    label: "agents-md",
    lifetime: "durable",
    on: "session:start",
    content: (c: { contextFiles?: unknown[] }) =>
      c.contextFiles ? "path/AGENTS.md:\nAGENTS.md content: always run tests.\n\nskills: web-animations..." : null,
  } as never);
  registerReminder(pi as never, {
    id: "tool-search",
    label: "tool-search",
    lifetime: "durable",
    on: "session:start",
    content: () => "tool_search nudge text",
  } as never);
  // A transient reminder standing in for pi-flows traffic.
  registerReminder(pi as never, {
    id: "flows",
    label: "flows",
    lifetime: "transient",
    on: "turn:start",
    content: () => "flows trigger noise",
  } as never);
}

const FILES = [{ path: "path/AGENTS.md", content: "AGENTS.md content: always run tests." }];

describe("durable reminders persist across the whole session (integration)", () => {
  it("sent once, before the first user prompt; replays turns 2/5 and on resume", async () => {
    const rt = makeRuntime();
    boot(rt.pi);

    const firePrompt = async (text: string) => {
      // 1. before_agent_start: captures files; durable sender fires once.
      await rt.handlers.get("before_agent_start")!({ systemPromptOptions: { contextFiles: FILES } }, rt.ctx);
      // 2. The user prompt appended by pi's runAgentLoop.
      rt.appendPrompt("user", text);
      // 3. Context event on a deep copy (emitContext structuredClones).
      const out = (await rt.handlers.get("context")!({ messages: structuredClone(rt.state) }, {})) as
        | { messages: StateMessage[] }
        | undefined;
      const messages = out?.messages ?? rt.state;
      // 4. REAL convertToLlm; keep the pre-projection copy for transient checks.
      const llm = convertToLlm(messages as never[]);
      const preProjection = llm.map((m) => ({
        role: m.role,
        content: (m.content as Array<{ text: string }>).map((p) => p.text).join(""),
      }));
      // 5. REAL deepseek projection.
      const payload = {
        system: "full pi system prompt (AGENTS.md + skills normally here)",
        tools: [{ name: "bash" }, { name: "str_replace_editor" }, { name: "read" }, { name: "web_search" }],
        messages: preProjection.map((m) => ({ ...m })),
      };
      projectMinimalPayload(payload);
      return { payload, preProjection };
    };

    const wire1 = await firePrompt("first task");
    rt.appendPrompt("assistant", "done");
    const wire2 = await firePrompt("second task");
    rt.appendPrompt("assistant", "ok");
    rt.appendPrompt("user", "t3");
    rt.appendPrompt("assistant", "ok");
    rt.appendPrompt("user", "t4");
    rt.appendPrompt("assistant", "ok");
    const wire5 = await firePrompt("fifth task");

    const has = (msgs: Array<{ role: string; content: string }>, needle: string) =>
      msgs.some((m) => m.content.includes(needle));

    // Wire shape at turn 1: user role, envelope, durable markers, before user1.
    const first = wire1.payload.messages[0];
    expect(first.role).toBe("user");
    expect(first.content.startsWith("<system_reminder>\n")).toBe(true);
    expect(first.content).toContain('<reminder type="agents-md" durable="true">');
    expect(first.content).toContain('<reminder type="tool-search" durable="true">');
    expect(wire1.payload.messages.some((m) => m.content === "first task")).toBe(true);
    expect(wire1.payload.messages[wire1.payload.messages.length - 1].content).toContain("first task");
    expect(wire1.payload.system).toBe("You are a helpful software engineer assistant.");

    // Persistence: every later turn carries the durable block (transcript replay).
    for (const wire of [wire2, wire5]) {
      expect(has(wire.payload.messages, "AGENTS.md content")).toBe(true);
      expect(has(wire.payload.messages, "tool_search nudge")).toBe(true);
    }

    // Resume: the persisted transcript carries exactly one durable block.
    const resumedState = structuredClone(rt.state);
    const durableBlocks = resumedState.filter(
      (m) => m.role === "custom" && m.customType === SYSTEM_REMINDER_CUSTOM_TYPE,
    );
    expect(durableBlocks).toHaveLength(1);
    expect(rt.sentMessages).toHaveLength(1); // send-once across all prompts

    // Ordering in the transcript: block immediately before the first user prompt.
    expect(rt.state[0].role).toBe("custom");
    expect((rt.state[1].content as Array<{ text: string }>)[0].text).toBe("first task");

    // Transient traffic stays per-turn and the deepseek wire filter strips it
    // (unsanctioned) while keeping the persisted durable pair.
    expect(has(wire2.preProjection, "flows trigger noise")).toBe(true);
    expect(has(wire2.payload.messages, "flows trigger noise")).toBe(false);
    const t2block = wire2.payload.messages.find((m) => m.content.includes("AGENTS.md content"));
    expect(t2block).toBeDefined();
    expect(t2block!.content).toContain('durable="true"');
  });
});
