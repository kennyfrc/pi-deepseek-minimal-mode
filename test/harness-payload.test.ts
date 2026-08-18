import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MinimalModeConfig } from "../src/gate.js";
import { WHITELIST_ALL_SENTINEL } from "../src/gate.js";
import {
  HARNESS_SYSTEM_PROMPT,
  extractComposition,
  filterSystemReminderBlocks,
  harnessTools,
  projectMinimalPayload,
  resolveAugmentedWireTools,
  wireToolName,
} from "../src/harness-payload.js";

const REFERENCE_COMPOSITION_BYTES = readFileSync(
  new URL("./fixtures/deepseek-harness-rc5-composition.json", import.meta.url),
  "utf8",
).trimEnd();

const strict: MinimalModeConfig = {
  mode: "auto",
  profile: "strict",
  deepseekPatterns: [/deepseek/i],
  whitelist: [],
};

function augmented(whitelist: string[]): MinimalModeConfig {
  return { ...strict, profile: "augmented", whitelist };
}

function liveTool(name: string, marker: string) {
  return {
    type: "function",
    function: {
      name,
      description: `${name} live`,
      parameters: {
        type: "object",
        properties: { marker: { const: marker }, nested: { anyOf: [{ type: "string" }, { type: "null" }] } },
      },
      strict: false,
      provider_extension: marker,
    },
  };
}

describe("strict composition", () => {
  it("uses the frozen pair and preserves every request parameter", () => {
    const params = {
      store: false,
      max_completion_tokens: 1234,
      max_tokens: 9876,
      reasoning_effort: "medium",
      thinking: { type: "disabled" },
      temperature: 0.7,
      top_p: 0.8,
      stream: false,
      stream_options: { include_usage: false },
    };
    const payload: Record<string, unknown> = {
      ...params,
      system: "pi identity",
      tools: [liveTool("bash", "b"), liveTool("ask_user", "a"), liveTool("str_replace_editor", "e")],
      messages: [
        { role: "system", content: "pi system" },
        { role: "system", content: "second system" },
        {
          role: "user",
          content:
            "prefix\n<system_reminder>\n<reminder type=\"tool-search\" durable=\"true\">old</reminder>\n</system_reminder>\nsuffix",
        },
      ],
    };

    expect(projectMinimalPayload(payload, strict)).toBe(true);
    expect(JSON.stringify(extractComposition(payload))).toBe(REFERENCE_COMPOSITION_BYTES);
    expect(payload.system).toBe(HARNESS_SYSTEM_PROMPT);
    expect((payload.messages as Array<{ role: string; content: unknown }>).filter((message) => message.role === "system")).toEqual([]);
    expect(JSON.stringify(payload.messages)).not.toContain("system_reminder");
    expect(JSON.stringify(payload.messages)).toContain("prefix");
    expect(JSON.stringify(payload.messages)).toContain("suffix");
    for (const [key, value] of Object.entries(params)) expect(payload[key]).toEqual(value);
  });

  it("creates the strict composition when tools or system input are absent", () => {
    const payload: Record<string, unknown> = { messages: [{ role: "user", content: "hello" }] };
    expect(projectMinimalPayload(payload, strict)).toBe(true);
    expect(payload.tools).toEqual(harnessTools());
    expect(payload.messages).toEqual([
      { role: "system", content: HARNESS_SYSTEM_PROMPT },
      { role: "user", content: "hello" },
    ]);
  });

  it("canonicalizes array system input and preserves non-text user parts", () => {
    const image = { type: "image", data: "abc" };
    const payload: Record<string, unknown> = {
      system: [{ type: "text", text: "pi" }, { type: "text", text: "more" }],
      messages: [
        { role: "system", content: [{ type: "text", text: "nested" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "<system_reminder>\n<reminder type=\"flows\">noise</reminder>\n</system_reminder>" },
            image,
          ],
        },
      ],
    };
    expect(projectMinimalPayload(payload, strict)).toBe(true);
    expect(payload.system).toEqual([{ type: "text", text: HARNESS_SYSTEM_PROMPT }]);
    expect((payload.messages as any[])[0].content).toEqual([image]);
  });

  it("scrubs reminder syntax from assistant text without losing ordinary text", () => {
    const payload: Record<string, unknown> = {
      system: "pi",
      messages: [
        {
          role: "assistant",
          content:
            "before\n<system_reminder>\n<reminder type=\"tool-search\" durable=\"true\">old</reminder>\n</system_reminder>\nafter",
        },
      ],
    };
    expect(projectMinimalPayload(payload, strict)).toBe(true);
    expect(JSON.stringify(payload.messages)).not.toContain("system_reminder");
    expect(JSON.stringify(payload.messages)).toContain("before");
    expect(JSON.stringify(payload.messages)).toContain("after");
  });

  it("is idempotent after projection", () => {
    const payload: Record<string, unknown> = {
      system: HARNESS_SYSTEM_PROMPT,
      tools: harnessTools(),
      messages: [{ role: "user", content: "hi" }],
    };
    expect(projectMinimalPayload(payload, strict)).toBe(false);
  });
});

describe("augmented composition", () => {
  it("selects complete live schemas in core then config order", () => {
    const bash = liveTool("bash", "b");
    const editor = liveTool("str_replace_editor", "e");
    const askUser = liveTool("ask_user", "a");
    const todo = liveTool("todo", "t");
    const payloadTools = [askUser, liveTool("mcp", "m"), todo, editor, bash];
    const output = resolveAugmentedWireTools(
      payloadTools,
      ["todo", "bash", "ask_user", "todo", "missing"],
      new Set(["todo", "ask_user"]),
    );
    expect(output).toEqual([bash, editor, todo, askUser]);
    expect(output[0]).toBe(bash);
    expect(output[1]).toBe(editor);
    expect(output[2]).toBe(todo);
    expect(output[3]).toBe(askUser);
  });

  it("falls back only for missing core schemas and never fabricates extras", () => {
    const askUser = liveTool("ask_user", "a");
    const output = resolveAugmentedWireTools([askUser], ["ask_user", "missing"], new Set(["ask_user"]));
    expect(output.slice(0, 2)).toEqual(harnessTools());
    expect(output[2]).toBe(askUser);
    expect(output).toHaveLength(3);
  });

  it("expands the all-tools sentinel at the wire level through projectMinimalPayload", () => {
    const tools = [
      liveTool("bash", "b"),
      liveTool("str_replace_editor", "e"),
      liveTool("read", "r"),
      liveTool("apply_patch", "p"),
      liveTool("ask_user", "a"),
      liveTool("todo", "t"),
      liveTool("memo", "m"),
    ];
    const config = augmented([WHITELIST_ALL_SENTINEL]);
    const registered = new Set(["bash", "str_replace_editor", "read", "apply_patch", "ask_user", "todo", "memo"]);
    const payload: Record<string, unknown> = { system: "pi", tools: [...tools], messages: [] };
    expect(projectMinimalPayload(payload, config, registered)).toBe(true);
    const names = (payload.tools as unknown[]).map((tool) => wireToolName(tool));
    // Core pair first, then registered extras in registration order, swap-owned trio and GPT-only apply_patch excluded.
    expect(names.slice(0, 2)).toEqual(["bash", "str_replace_editor"]);
    expect(names.slice(2)).toContain("ask_user");
    expect(names.slice(2)).toContain("todo");
    expect(names.slice(2)).toContain("memo");
    expect(names).not.toContain("read");
    expect(names).not.toContain("apply_patch");
  });

  it("keeps only durable agents-md and preserves mixed user text", () => {
    const combined = [
      "before",
      "<system_reminder>",
      '<reminder type="agents-md" durable="true">AGENTS</reminder>',
      '<reminder type="tool-search" durable="true">old nudge</reminder>',
      '<reminder type="agents-md">transient agents</reminder>',
      '<reminder type="flows">flow noise</reminder>',
      "</system_reminder>",
      "after",
    ].join("\n");
    const payload: Record<string, unknown> = {
      system: "pi",
      tools: [liveTool("bash", "b"), liveTool("str_replace_editor", "e")],
      messages: [
        { role: "user", content: combined },
        {
          role: "user",
          content: "<system_reminder>\n<reminder type=\"tool-search\" durable=\"true\">only old</reminder>\n</system_reminder>",
        },
      ],
    };
    expect(projectMinimalPayload(payload, augmented([]))).toBe(true);
    const text = JSON.stringify(payload.messages);
    expect(text).toContain("AGENTS");
    expect(text).toContain("before");
    expect(text).toContain("after");
    expect(text).not.toContain("old nudge");
    expect(text).not.toContain("transient agents");
    expect(text).not.toContain("flow noise");
    expect(text).not.toContain("only old");
    expect(payload.messages).toHaveLength(1);
  });

  it("removes obsolete reminder syntax echoed by an assistant", () => {
    const payload: Record<string, unknown> = {
      system: "pi",
      tools: harnessTools(),
      messages: [
        {
          role: "assistant",
          content:
            "before\n<system_reminder>\n<reminder type=\"tool-search\" durable=\"true\">old</reminder>\n</system_reminder>\nafter",
        },
      ],
    };
    expect(projectMinimalPayload(payload, augmented([]), new Set())).toBe(true);
    expect(JSON.stringify(payload.messages)).not.toContain("tool-search");
    expect(JSON.stringify(payload.messages)).toContain("before");
    expect(JSON.stringify(payload.messages)).toContain("after");
  });

  it("filters complete reminder blocks outside a payload", () => {
    const text = "x<system_reminder><reminder type=\"agents-md\" durable=\"true\">A</reminder><reminder type=\"flows\">F</reminder></system_reminder>y";
    expect(filterSystemReminderBlocks(text, "strict")).toBe("xy");
    expect(filterSystemReminderBlocks(text, "augmented")).toContain("A");
    expect(filterSystemReminderBlocks(text, "augmented")).not.toContain("F");
  });
});

describe("composition view", () => {
  it("extracts one provider-independent system message and the tool bytes", () => {
    const payload: Record<string, unknown> = { system: "pi", tools: [liveTool("bash", "b")], messages: [] };
    projectMinimalPayload(payload, strict);
    expect(extractComposition(payload)).toEqual({
      systemMessages: [{ role: "system", content: HARNESS_SYSTEM_PROMPT }],
      tools: harnessTools(),
    });
  });
});
