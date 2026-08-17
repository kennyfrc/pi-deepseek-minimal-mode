/**
 * pi-deepseek-minimal-mode — harness payload projection.
 *
 * Ground truth: the DeepSeek Harness `minimal` preset's wire request
 * (the reference RL harness's minimal agent preset, dumped via the
 * requestHeader instrumentation). For minimal models the provider payload is
 * projected 1:1 onto that reference:
 *
 * - system: the preset persona, verbatim — "You are a helpful software
 *   engineer assistant." Nothing else (no identity, no guidelines, no tool
 *   snippets).
 * - tools: exactly two entries — [bash, str_replace_editor]. By default pi's
 *   LIVE wire entries are preserved verbatim (open schema, strict flag,
 *   full descriptions — the model can use timeout/background/job/action);
 *   the frozen harness pair below is the fallback and the A/B reference
 *   (PI_MINIMAL_WIRE_VARIANT=harness forces it). The register is unaffected
 *   by this choice (verified live: both variants produce the RL trace); only
 *   the system slot matters.
 * - request params: exactly the harness serializer's fields — stream,
 *   stream_options, thinking {type: enabled}, reasoning_effort high, and
 *   max_tokens 65536; pi-only extras (store, max_completion_tokens) are
 *   dropped. pi's system_reminder traffic is the sanctioned delta and stays
 *   on the wire untouched.
 *
 * The allowed delta is the system_reminder traffic carried by
 * pi-system-reminders — the persisted durable pair (agents-md, tool-search;
 * sent once before the first user prompt, marked durable="true", replaying
 * every request) — everything else must match byte-for-byte.
 */

/** The harness minimal persona: the complete system prompt. */
export const HARNESS_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

/** Persistent bash, as configured by the minimal preset (agent.cordis.yml). */
const HARNESS_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`;

/** str_replace_editor, as shipped by the reference RL harness (DEFAULT_DESCRIPTION). */
const HARNESS_EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``;

/** The exact two-entry tools array the harness minimal preset sends. */
export function harnessTools(): unknown[] {
  return [
    {
      type: "function",
      function: {
        name: "bash",
        description: HARNESS_BASH_DESCRIPTION,
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
        description: HARNESS_EDITOR_DESCRIPTION,
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
}

/**
 * The wire request parameters the harness minimal request carries beyond
 * the payload body (from llm-chat-completions: adapter default effort `high`,
 * DEFAULT_MAX_TOKENS = 65536, always streaming with usage).
 */
export const HARNESS_WIRE_PARAMS: Readonly<Record<string, unknown>> = Object.freeze({
  stream: true,
  stream_options: { include_usage: true },
  thinking: { type: "enabled" },
  reasoning_effort: "high",
  max_tokens: 65536,
});

/** Request keys the harness serializer never emits for this preset. */
const HARNESS_ABSENT_KEYS = ["store", "max_completion_tokens", "temperature", "top_p"] as const;

/*
 * system_reminder traffic (pi-system-reminders: transient per-turn blocks and
 * the persisted durable pair) is the sanctioned delta and stays on the wire
 * as-is; the projection replaces only the system prompt, the tools array,
 * and the request params.
 */

/** Mutable wire-payload shape (subset we touch). */
interface WirePayload {
  tools?: unknown;
  system?: unknown;
  messages?: unknown;
  [key: string]: unknown;
}

/** Read a tool entry's name from either flat or OpenAI-nested payload shapes. */
function wireToolName(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  if (typeof record.name === "string" && record.name.length > 0) return record.name;
  const fn = record.function;
  if (fn && typeof fn === "object") {
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return undefined;
}

/**
 * Compute the two-entry tools array for the wire: pi's LIVE bash and
 * str_replace_editor entries, exactly as pi serialized them (open schema,
 * strict flag, anyOf shapes — all preserved), in stable order. Falls back to
 * the harness reference pair when the payload does not carry recognizable
 * entries for both (e.g. a provider that dropped them).
 */
export function resolveWireTools(tools: unknown[], fallback: () => unknown[] = harnessTools): unknown[] {
  const bash = tools.find((t) => wireToolName(t) === "bash");
  const editor = tools.find((t) => wireToolName(t) === "str_replace_editor");
  if (bash !== undefined && editor !== undefined) return [bash, editor];
  return fallback();
}

/**
 * The ONLY reminder blocks the minimal wire may carry: this extension's own
 * durable session:start pair. The pair is PERSISTED as a session message
 * before the first user prompt (inner tags marked durable="true") and
 * replays from the transcript in every later request and on resume — the
 * filter keeps it wherever it appears in user messages. Every other
 * extension's transient reminder traffic (flows, memo, skill catalogs...)
 * is stripped from the payload — injected catalog text is the measured
 * anchor-breaker for this preset.
 */
export const SANCTIONED_REMINDER_TYPES = new Set(["agents-md", "tool-search"]);

/** Drop system_reminder blocks whose type is not sanctioned. */
export function filterSystemReminderBlocks(text: string): string {
  const BLOCK = /<system_reminder>[\s\S]*?<\/system_reminder>/g;
  const TYPE = /<reminder\s+type="([^"]+)"/;
  return text.replace(BLOCK, (block) => {
    const match = TYPE.exec(block);
    return match && SANCTIONED_REMINDER_TYPES.has(match[1]) ? block : "";
  });
}

/**
 * Project a provider payload onto the harness minimal reference, in place.
 * Returns true when anything changed. The payload's message history keeps
 * ONLY the sanctioned durable reminder blocks (agents-md, tool-search —
 * including their persisted replays in later turns and on resume);
 * everything else pi injected (transient reminders from other extensions)
 * is stripped. The system string is replaced with the persona, and the
 * tools array collapses to exactly [bash, str_replace_editor] — pi's own
 * live entries when present (pass `wireTools` to override, e.g. the frozen
 * harness pair).
 */
export function projectMinimalPayload(payload: WirePayload, wireTools?: readonly unknown[]): boolean {
  let changed = false;

  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return false;

  // 1. Tools: exactly the two-entry pair (live pi entries by default).
  const next = wireTools ?? resolveWireTools(payload.tools);
  if (JSON.stringify(payload.tools) !== JSON.stringify(next)) {
    payload.tools = next;
    changed = true;
  }

  // 2. System prompt: the preset persona replaces everything else.
  const replaceSystemText = (value: string): string => {
    if (value === HARNESS_SYSTEM_PROMPT) return value;
    changed = true;
    return HARNESS_SYSTEM_PROMPT;
  };
  if (typeof payload.system === "string") {
    payload.system = replaceSystemText(payload.system);
  } else if (Array.isArray(payload.system)) {
    for (const part of payload.system as Array<{ type?: string; text?: unknown }>) {
      if (part && part.type === "text" && typeof part.text === "string") {
        part.text = replaceSystemText(part.text);
      }
    }
  }
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages as Array<{ role?: string; content?: unknown }>) {
      if (!message || message.role !== "system") continue;
      if (typeof message.content === "string") {
        message.content = replaceSystemText(message.content);
      } else if (Array.isArray(message.content)) {
        for (const part of message.content as Array<{ type?: string; text?: unknown }>) {
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = replaceSystemText(part.text);
          }
        }
      }
    }
  }

  // 2b. User messages: keep only sanctioned reminder blocks.
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages as Array<{ role?: string; content?: unknown }>) {
      if (!message || message.role !== "user") continue;
      const scrub = (text: string): string => {
        const next = filterSystemReminderBlocks(text);
        if (next !== text) changed = true;
        return next;
      };
      if (typeof message.content === "string") {
        message.content = scrub(message.content);
      } else if (Array.isArray(message.content)) {
        for (const part of message.content as Array<{ type?: string; text?: unknown }>) {
          if (part && part.type === "text" && typeof part.text === "string") {
            part.text = scrub(part.text);
          }
        }
      }
    }
  }

  // 3. Wire request params: exactly the harness serializer's fields.
  for (const key of HARNESS_ABSENT_KEYS) {
    if (payload[key] !== undefined) {
      delete payload[key];
      changed = true;
    }
  }
  for (const [key, value] of Object.entries(HARNESS_WIRE_PARAMS)) {
    if (JSON.stringify(payload[key]) !== JSON.stringify(value)) {
      payload[key] = value;
      changed = true;
    }
  }

  return changed;
}
