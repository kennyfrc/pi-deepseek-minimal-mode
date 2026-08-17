/**
 * Harness-payload projection tests.
 *
 * The reference below is the reference RL harness minimal preset's actual wire
 * request, captured by instrumenting its requestHeader (apps/web/tests/
 * tmp-minimal-payload.spec.ts → tmp-minimal-payload.json). projectMinimalPayload
 * must turn any pi provider payload into exactly that system + tools pair,
 * and drop the request keys the harness serializer never emits.
 */
import { describe, expect, it } from "vitest";
import {
  HARNESS_SYSTEM_PROMPT,
  HARNESS_WIRE_PARAMS,
  harnessTools,
  projectMinimalPayload,
} from "../src/harness-payload.js";

/** Reference: harness minimal requestHeader().tools, verbatim. */
const HARNESS_REFERENCE_TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description:
        'Run commands in a bash shell\n* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.\n* You don\'t have access to the internet via this tool.\n* You do have access to a mirror of common linux and python packages via apt and pip.\n* State is persistent across command calls and discussions with the user.\n* To inspect a particular line range of a file, e.g. lines 10-25, try \'sed -n 10,25p /path/to/the/file\'.\n* Please avoid commands that may produce a very large amount of output.\n* Please run long lived commands in the background, e.g. \'sleep 10 &\' or start a server in the background.',
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to run. Relative path is preferred in the command.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "str_replace_editor",
      description:
        "Custom editing tool for viewing, creating and editing files\n* State is persistent across command calls and discussions with the user\n* If `path` is a file, `view` displays the result of applying `cat -n`. If `path` is a directory, `view` lists non-hidden files and directories up to 2 levels deep\n* The `create` command cannot be used if the specified `path` already exists as a file\n* If a `command` generates a long output, it will be truncated and marked with `<response clipped>`\n\nNotes for using the `str_replace` command:\n* The `old_str` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!\n* If the `old_str` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in `old_str` to make it unique\n* The `new_str` parameter should contain the edited lines that should replace the `old_str`",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
            enum: ["view", "create", "str_replace", "insert"],
          },
          path: {
            type: "string",
            description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.",
          },
          file_text: {
            type: "string",
            description: "Required parameter of `create` command, with the content of the file to be created.",
          },
          insert_line: {
            type: "integer",
            description:
              "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
          },
          new_str: {
            type: "string",
            description:
              "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
          },
          old_str: {
            type: "string",
            description: "Required parameter of `str_replace` command containing the string in `path` to replace.",
          },
          view_range: {
            type: "array",
            description:
              "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
            items: { type: "integer" },
          },
        },
        required: ["command", "path"],
      },
    },
  },
];

describe("harness-payload projection", () => {
  it("the harness reference pair is byte-identical to the captured fixture", () => {
    expect(JSON.stringify(harnessTools())).toBe(JSON.stringify(HARNESS_REFERENCE_TOOLS));
  });

  it("projects a realistic pi payload: live entries kept, extras dropped", () => {
    const piBash = { type: "function", function: { name: "bash", description: "pi bash", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } }, strict: false } };
    const piEditor = { type: "function", function: { name: "str_replace_editor", description: "pi editor", parameters: { type: "object" } } };
    const payload = {
      model: "deepseek-ai/DeepSeek-V4-Flash",
      messages: [
        { role: "system", content: "You are Pi, a coding agent...\nAvailable tools:\n- bash: Run commands...\n- tool_search: ..." },
        { role: "user", content: [{ type: "text", text: "<system_reminder>\n<reminder type=\"flows\">\nflow noise\n</reminder>\n</system_reminder>" }] },
        { role: "user", content: [{ type: "text", text: "<system_reminder>\n<reminder type=\"agents-md\">\nAGENTS.md\n</reminder>\n</system_reminder>" }] },
        { role: "user", content: [{ type: "text", text: "<system_reminder>\n<reminder type=\"tool-search\">\nuse tool_search\n</reminder>\n</system_reminder>" }] },
        { role: "user", content: "hello" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      store: false,
      max_completion_tokens: 16384,
      reasoning_effort: "medium",
      tools: [
        { type: "function", function: { name: "bash", description: "pi bash", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } }, strict: false } },
        { type: "function", function: { name: "tool_search", description: "Find tools." } },
        { type: "function", function: { name: "mcp", description: "MCP gateway." } },
        { type: "function", function: { name: "str_replace_editor", description: "pi editor", parameters: { type: "object" } } },
      ],
    } as Record<string, unknown>;

    const changed = projectMinimalPayload(payload);
    expect(changed).toBe(true);
    // Tools: exactly pi's live bash + str_replace_editor entries, verbatim,
    // in stable order; everything else dropped.
    expect(payload.tools).toEqual([piBash, piEditor]);
    expect((payload.messages as Array<{ role: string; content: string }>)[0].content).toBe(
      "You are a helpful software engineer assistant.",
    );
    // system_reminder user traffic: only the sanctioned durable pair
    // (agents-md, tool-search) survives; other extensions' transient
    // reminders (flows) are stripped from the wire.
    const messages = payload.messages as Array<{ role: string; content: unknown }>;
    expect(messages.length).toBe(5);
    expect(JSON.stringify(messages[1])).not.toContain("flow noise");
    expect(JSON.stringify(messages[2])).toContain("AGENTS.md");
    expect(JSON.stringify(messages[3])).toContain("use tool_search");
    // Wire params: exactly the harness serializer's fields.
    expect(payload.store).toBeUndefined();
    expect(payload.max_completion_tokens).toBeUndefined();
    expect(payload.reasoning_effort).toBe("high");
    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.max_tokens).toBe(65536);
    expect(payload.stream).toBe(true);
    expect(payload.stream_options).toEqual({ include_usage: true });
    expect(payload.model).toBe("deepseek-ai/DeepSeek-V4-Flash");
  });

  it("falls back to the frozen harness pair when the payload lacks live entries", () => {
    const payload = {
      tools: [{ type: "function", function: { name: "bash", description: "x" } }],
      system: "pi",
      messages: [],
    } as Record<string, unknown>;
    expect(projectMinimalPayload(payload)).toBe(true);
    expect(payload.tools).toEqual(HARNESS_REFERENCE_TOOLS);
  });

  it("wireTools override forces the frozen pair even when live entries exist", () => {
    const payload = {
      tools: [
        { type: "function", function: { name: "bash", description: "pi bash" } },
        { type: "function", function: { name: "str_replace_editor", description: "pi editor" } },
      ],
      system: "pi",
      messages: [],
    } as Record<string, unknown>;
    expect(projectMinimalPayload(payload, HARNESS_REFERENCE_TOOLS)).toBe(true);
    expect(payload.tools).toEqual(HARNESS_REFERENCE_TOOLS);
  });

  it("handles anthropic-style system arrays", () => {
    const payload = {
      tools: [{ name: "bash" }],
      system: [{ type: "text", text: "pi identity" }, { type: "text", text: "more" }],
      messages: [{ role: "system", content: [{ type: "text", text: "nested" }] }],
    } as Record<string, unknown>;
    expect(projectMinimalPayload(payload)).toBe(true);
    expect(payload.system).toEqual([{ type: "text", text: HARNESS_SYSTEM_PROMPT }, { type: "text", text: HARNESS_SYSTEM_PROMPT }]);
    expect(payload.messages).toEqual([{ role: "system", content: [{ type: "text", text: HARNESS_SYSTEM_PROMPT }] }]);
  });

  it("is idempotent and reports no change on an already-projected payload", () => {
    const payload = {
      tools: harnessTools(),
      system: HARNESS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: "hi" }],
      ...HARNESS_WIRE_PARAMS,
    } as Record<string, unknown>;
    expect(projectMinimalPayload(payload)).toBe(false);
  });

  it("leaves payloads without tools alone", () => {
    const payload = { messages: [{ role: "user", content: "hi" }] } as Record<string, unknown>;
    expect(projectMinimalPayload(payload)).toBe(false);
    expect(payload).toEqual({ messages: [{ role: "user", content: "hi" }] });
  });

  it("keeps the PERSISTED durable block (durable=\"true\" marker) on the wire in later turns", () => {
    // The durable agents-md/tool-search pair is persisted as a session message
    // before the first user prompt and replays in every later request. Its
    // inner <reminder> tags carry durable="true"; the wire filter must keep
    // them (type stays the first attribute, so the sanction regex matches).
    const persisted = [
      "<system_reminder>",
      '<reminder type="agents-md" durable="true">',
      "/a/AGENTS.md:\n# Policy",
      "</reminder>",
      '<reminder type="tool-search" durable="true">',
      "use tool_search first",
      "</reminder>",
      "</system_reminder>",
    ].join("\n");
    const payload = {
      tools: [
        { type: "function", function: { name: "bash", description: "pi bash", parameters: { type: "object" } } },
        { type: "function", function: { name: "str_replace_editor", description: "pi editor", parameters: { type: "object" } } },
      ],
      system: "pi",
      messages: [
        { role: "user", content: persisted }, // turn-5 replay of the persisted block
        { role: "assistant", content: "done" },
        {
          role: "user",
          content:
            "<system_reminder>\n<reminder type=\"flows\">\nflow noise\n</reminder>\n</system_reminder>\nnext task",
        },
      ],
    } as Record<string, unknown>;
    expect(projectMinimalPayload(payload)).toBe(true);
    const messages = payload.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain('<reminder type="agents-md" durable="true">');
    expect(messages[0].content).toContain('<reminder type="tool-search" durable="true">');
    expect(messages[2].content).not.toContain("flow noise");
    expect(messages[2].content).toContain("next task");
  });
});
