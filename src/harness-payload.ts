/**
 * Final provider composition for DeepSeek minimal profiles.
 *
 * Strict writes the frozen reference persona and tool pair. Augmented writes
 * the same persona, keeps the complete live core schemas, and appends complete
 * live schemas for configured extra tools. Request parameters are outside this
 * module's ownership and remain untouched.
 */
import { registeredWhitelistTools, type MinimalModeConfig, type MinimalProfile } from "./gate.js";

export const HARNESS_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

const HARNESS_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`;

const HARNESS_EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``;

/** A fresh copy of the exact two-tool Harness reference. */
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

export interface WirePayload {
  tools?: unknown;
  system?: unknown;
  messages?: unknown;
  [key: string]: unknown;
}

export interface CompositionView {
  systemMessages: readonly unknown[];
  tools: readonly unknown[];
}

type Message = { role?: string; content?: unknown; [key: string]: unknown };
type TextPart = { type?: string; text?: unknown; [key: string]: unknown };

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`pi-deepseek-minimal-mode invariant: ${message}`);
}

/** Read a provider tool name from flat and OpenAI-nested entries. */
export function wireToolName(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  if (typeof record.name === "string" && record.name.length > 0) return record.name;
  const fn = record.function;
  if (!fn || typeof fn !== "object") return undefined;
  const name = (fn as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/** Select complete live core and registered extra entries in deterministic order. */
export function resolveAugmentedWireTools(
  payloadTools: unknown,
  whitelist: readonly string[],
  registeredNames: ReadonlySet<string>,
): unknown[] {
  const entries = Array.isArray(payloadTools) ? payloadTools : [];
  const byName = new Map<string, unknown>();
  for (const entry of entries) {
    const name = wireToolName(entry);
    if (name && !byName.has(name)) byName.set(name, entry);
  }

  const frozen = harnessTools();
  const bash = byName.get("bash") ?? frozen[0];
  const editor = byName.get("str_replace_editor") ?? frozen[1];
  const result: unknown[] = [bash, editor];
  const seen = new Set(["bash", "str_replace_editor"]);
  for (const name of whitelist) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!registeredNames.has(name)) continue;
    const entry = byName.get(name);
    invariant(entry !== undefined, `registered augmented tool is missing from provider payload: ${name}`);
    result.push(entry);
  }

  invariant(wireToolName(result[0]) === "bash", "augmented bash must be first");
  invariant(wireToolName(result[1]) === "str_replace_editor", "augmented editor must be second");
  invariant(new Set(result.map(wireToolName)).size === result.length, "augmented tools must be unique");
  return result;
}

const REMINDER_BLOCK = /<system_reminder>[\s\S]*?<\/system_reminder>/g;
const REMINDER_SECTION = /<reminder\b([^>]*)>[\s\S]*?<\/reminder>/g;

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1];
}

/** Remove disallowed reminder sections while preserving ordinary text. */
export function filterSystemReminderBlocks(text: string, profile: MinimalProfile): string {
  return text.replace(REMINDER_BLOCK, (block) => {
    if (profile === "strict") return "";
    let kept = 0;
    const filtered = block.replace(REMINDER_SECTION, (section, attributes: string) => {
      const keep = attribute(attributes, "type") === "agents-md" && attribute(attributes, "durable") === "true";
      if (keep) kept += 1;
      return keep ? section : "";
    });
    return kept > 0 ? filtered : "";
  });
}

function scrubText(text: string, profile: MinimalProfile): string {
  return filterSystemReminderBlocks(text, profile);
}

function scrubMessage(message: Message, profile: MinimalProfile): Message | null {
  if (typeof message.content === "string") {
    const content = scrubText(message.content, profile);
    return content.trim().length > 0 ? { ...message, content } : null;
  }
  if (!Array.isArray(message.content)) return message;

  const content: unknown[] = [];
  for (const part of message.content) {
    if (part && typeof part === "object" && (part as TextPart).type === "text" && typeof (part as TextPart).text === "string") {
      const text = scrubText((part as TextPart).text as string, profile);
      if (text.trim().length > 0) content.push({ ...(part as TextPart), text });
    } else {
      content.push(part);
    }
  }
  return content.length > 0 ? { ...message, content } : null;
}

function canonicalizeMessages(messages: unknown, profile: MinimalProfile): unknown {
  if (!Array.isArray(messages)) return messages;
  const result: unknown[] = [];
  let systemSeen = false;
  for (const value of messages) {
    if (!value || typeof value !== "object") {
      result.push(value);
      continue;
    }
    const message = value as Message;
    if (message.role === "system") {
      if (systemSeen) continue;
      systemSeen = true;
      result.push({ ...message, content: HARNESS_SYSTEM_PROMPT });
      continue;
    }
    const scrubbed = scrubMessage(message, profile);
    if (scrubbed) result.push(scrubbed);
  }
  return result;
}

function projectSystemAndMessages(payload: WirePayload, profile: MinimalProfile): void {
  if (typeof payload.system === "string") {
    payload.system = HARNESS_SYSTEM_PROMPT;
  } else if (Array.isArray(payload.system)) {
    payload.system = [{ type: "text", text: HARNESS_SYSTEM_PROMPT }];
  }

  const hadSystemMessage =
    Array.isArray(payload.messages) && payload.messages.some((message) => message && typeof message === "object" && (message as Message).role === "system");
  payload.messages = canonicalizeMessages(payload.messages, profile);

  if (payload.system !== undefined && Array.isArray(payload.messages)) {
    payload.messages = payload.messages.filter(
      (message) => !message || typeof message !== "object" || (message as Message).role !== "system",
    );
  } else if (payload.system === undefined && Array.isArray(payload.messages) && !hadSystemMessage) {
    payload.messages = [{ role: "system", content: HARNESS_SYSTEM_PROMPT }, ...payload.messages];
  } else if (payload.system === undefined && payload.messages === undefined) {
    payload.system = HARNESS_SYSTEM_PROMPT;
  }
}

function compositionSnapshot(payload: WirePayload): string {
  return JSON.stringify({ system: payload.system, messages: payload.messages, tools: payload.tools });
}

export function projectStrictComposition(payload: WirePayload): boolean {
  const before = compositionSnapshot(payload);
  payload.tools = harnessTools();
  projectSystemAndMessages(payload, "strict");
  invariant(JSON.stringify(payload.messages ?? []).includes("<system_reminder>") === false, "strict reminder survived");
  invariant(JSON.stringify(payload.tools) === JSON.stringify(harnessTools()), "strict tool pair drifted");
  return before !== compositionSnapshot(payload);
}

export function projectAugmentedComposition(
  payload: WirePayload,
  whitelist: readonly string[],
  registeredNames: ReadonlySet<string>,
): boolean {
  const before = compositionSnapshot(payload);
  payload.tools = resolveAugmentedWireTools(payload.tools, whitelist, registeredNames);
  projectSystemAndMessages(payload, "augmented");
  const reminderText = JSON.stringify(payload.messages ?? []);
  invariant(!reminderText.includes('type="tool-search"'), "obsolete reminder survived augmented projection");
  return before !== compositionSnapshot(payload);
}

/** Dispatch through the resolved profile without touching request parameters. */
export function projectMinimalPayload(
  payload: WirePayload,
  config: MinimalModeConfig,
  registeredNames: ReadonlySet<string> = new Set(config.whitelist),
): boolean {
  return config.profile === "strict"
    ? projectStrictComposition(payload)
    : projectAugmentedComposition(payload, registeredWhitelistTools(config, registeredNames), registeredNames);
}

/** Provider-independent composition view used by byte fixture tests. */
export function extractComposition(payload: WirePayload): CompositionView {
  const messages = Array.isArray(payload.messages) ? (payload.messages as Message[]) : [];
  const systemMessages = messages.filter((message) => message?.role === "system");
  if (systemMessages.length > 0) {
    return { systemMessages, tools: Array.isArray(payload.tools) ? payload.tools : [] };
  }
  if (payload.system !== undefined) {
    return {
      systemMessages: [{ role: "system", content: payload.system }],
      tools: Array.isArray(payload.tools) ? payload.tools : [],
    };
  }
  return { systemMessages: [], tools: Array.isArray(payload.tools) ? payload.tools : [] };
}
