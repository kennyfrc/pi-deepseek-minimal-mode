import { afterEach, describe, expect, it } from "vitest";
import { getReminders } from "@kennyfrc/pi-system-reminders";
import minimalModeExtension from "../src/index.js";
import { _setConfigForTesting } from "../src/gate.js";
import { harnessTools, projectMinimalPayload } from "../src/harness-payload.js";

const strictConfig = {
  mode: "auto",
  profile: "strict",
  deepseekPatterns: [/deepseek/i],
  whitelist: ["ask_user"],
} as const;

const augmentedConfig = {
  ...strictConfig,
  profile: "augmented",
  whitelist: ["todo", "ask_user", "todo"],
} as const;

afterEach(() => {
  _setConfigForTesting(null);
});

function liveTool(name: string, marker: string) {
  return {
    type: "function",
    function: {
      name,
      description: `${name} live`,
      parameters: { type: "object", properties: { marker: { const: marker } } },
      strict: false,
      provider_extension: marker,
    },
  };
}

describe("strict and augmented profile regressions", () => {
  it("strict uses the frozen pair, preserves request params, and removes resumed reminders", () => {
    const payload: Record<string, unknown> = {
      system: "pi system",
      tools: [liveTool("bash", "b"), liveTool("ask_user", "a"), liveTool("str_replace_editor", "e")],
      store: false,
      max_completion_tokens: 1234,
      reasoning_effort: "medium",
      messages: [
        {
          role: "user",
          content:
            "prefix\n<system_reminder>\n<reminder type=\"tool-search\" durable=\"true\">old nudge</reminder>\n</system_reminder>\nsuffix",
        },
      ],
    };

    expect(projectMinimalPayload(payload, strictConfig)).toBe(true);
    expect(JSON.stringify(payload.tools)).toBe(JSON.stringify(harnessTools()));
    expect(payload.store).toBe(false);
    expect(payload.max_completion_tokens).toBe(1234);
    expect(payload.reasoning_effort).toBe("medium");
    expect(JSON.stringify(payload.messages)).not.toContain("system_reminder");
    expect(JSON.stringify(payload.messages)).toContain("prefix");
    expect(JSON.stringify(payload.messages)).toContain("suffix");
  });

  it("augmented inlines complete extra schemas in config order and keeps only durable agents-md", () => {
    const bash = liveTool("bash", "b");
    const editor = liveTool("str_replace_editor", "e");
    const askUser = liveTool("ask_user", "a");
    const todo = liveTool("todo", "t");
    const payload: Record<string, unknown> = {
      system: "pi system",
      tools: [askUser, bash, liveTool("mcp", "m"), todo, editor],
      messages: [
        {
          role: "user",
          content: [
            "before",
            "<system_reminder>",
            '<reminder type="agents-md" durable="true">AGENTS</reminder>',
            '<reminder type="tool-search" durable="true">old nudge</reminder>',
            '<reminder type="flows">noise</reminder>',
            "</system_reminder>",
            "after",
          ].join("\n"),
        },
      ],
    };

    expect(projectMinimalPayload(payload, augmentedConfig)).toBe(true);
    expect(payload.tools).toEqual([bash, editor, todo, askUser]);
    expect((payload.tools as unknown[])[2]).toBe(todo);
    expect((payload.tools as unknown[])[3]).toBe(askUser);
    expect(JSON.stringify(payload.messages)).toContain("AGENTS");
    expect(JSON.stringify(payload.messages)).not.toContain("old nudge");
    expect(JSON.stringify(payload.messages)).not.toContain("noise");
    expect(JSON.stringify(payload.messages)).toContain("before");
    expect(JSON.stringify(payload.messages)).toContain("after");
  });

  it("registers no discovery tool or tool-search reminder", () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const registered: string[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => registered.push(tool.name),
      on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
      getAllTools: () => [],
      getActiveTools: () => ["bash", "str_replace_editor"],
      setActiveTools: () => {},
    };

    minimalModeExtension(pi as never);
    expect(registered).toEqual([]);
    expect(getReminders(pi as never).map((reminder) => reminder.id)).toEqual(["agents-md"]);
  });
});
