/**
 * pi-deepseek-minimal-mode — model gating.
 *
 * Mirrors the DeepSeek Harness `minimal` preset: for DeepSeek-family models
 * (configurable), the model-facing toolset collapses to `bash`,
 * `str_replace_editor`, and `tool_search` — the discovery channel. Every
 * other pi tool (web_search, web_fetch, read/edit/write, grep/find/ls, …)
 * stays registered but out of the active set; the model finds and activates
 * them on demand through tool_search.
 *
 * Why (from the Chinese community analysis of DSH minimal mode): DeepSeek
 * models drift with many tools; a minimal set removes tool-choice ambiguity,
 * shrinks per-request payload (prefill is slow and cached-prefix-sensitive on
 * Chinese models), and the claude-code-style str_replace_editor is the surface
 * these models were tuned on. tool_search keeps the full toolbox one call away
 * without paying its context cost every request.
 *
 * Coexistence contract with pi-str-replace-editor:
 * - That extension owns {read, edit, write, grep, find, ls, str_replace_editor}.
 *   This gate never touches those names for deepseek (str-replace-editor's
 *   block messages are better), and it computes its desired set from the
 *   CURRENT active set, so the two extensions converge in any load order.
 * - For non-deepseek models (mode auto) this gate only removes tool_search; it
 *   restores nothing else, so pi-str-replace-editor's restore stands.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Minimal model shape the gate needs. Structurally compatible with pi's Model. */
export interface GatableModel {
  id?: string;
  provider?: string;
  name?: string;
  api?: string;
}

export type FeatureMode = "auto" | "on" | "off";

/** Default pattern: deepseek anywhere in id/provider/name, case-insensitive. */
export const DEFAULT_DEEPSEEK_PATTERNS: readonly RegExp[] = [/deepseek/i];

/**
 * The always-active core for a minimal model. tool_search stays in the
 * ACTIVE set so the runtime can route its calls, but it is never injected
 * in the provider payload (see WIRE_CORE_TOOLS): the model learns to call
 * it from the reminder text, not from a tool definition.
 */
export const MINIMAL_CORE_TOOLS: readonly string[] = ["bash", "str_replace_editor", "tool_search"];

/**
 * The only tools ever injected in the provider payload for a minimal model.
 * Discovered tools and tool_search are callable by name (they sit in the
 * active set) but stay out of the payload; the model learns their names and
 * argument shapes from the tool_search result text.
 */
export const WIRE_CORE_TOOLS: readonly string[] = ["bash", "str_replace_editor"];

/** The payload-visible set for a minimal model: wire core + whitelist. */
export function wireAllowedTools(model: GatableModel | null | undefined): ReadonlySet<string> {
  const { whitelist } = loadConfig();
  return new Set([...WIRE_CORE_TOOLS, ...whitelist]);
}

/**
 * Extra tools kept in minimal mode. Default: none — the harness minimal
 * exposes ONLY bash + str_replace_editor in the payload. Whitelist tools
 * stay in the payload; everything else loads on demand via tool_search.
 */
export const DEFAULT_WHITELIST: readonly string[] = [];

/**
 * Tool names owned by pi-str-replace-editor's tool_call blocking. This gate
 * does not block them (better messages exist there), but it DOES drop them
 * from the active set for minimal models.
 */
export const STR_REPLACE_OWNED = ["read", "edit", "write", "grep", "find", "ls"] as const;

export interface MinimalModeConfig {
  mode: FeatureMode;
  deepseekPatterns: readonly RegExp[];
  /** Extra tool names kept alongside the core set in minimal mode. */
  whitelist: readonly string[];
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-deepseek-minimal-mode.json");
const CONFIG_ALTERNATE = join(homedir(), ".pi", "agent", "pi-deepseek-minimal-mode.json");

const DEFAULT_CONFIG: MinimalModeConfig = {
  mode: "auto",
  deepseekPatterns: DEFAULT_DEEPSEEK_PATTERNS,
  whitelist: DEFAULT_WHITELIST,
};

let cachedConfig: MinimalModeConfig | undefined;
/** Test override; survives resetConfigCache and wins over the disk file. */
let injectedConfig: MinimalModeConfig | null = null;

/** Drop the DISK config cache so file edits apply at the next session_start. */
export function resetConfigCache(): void {
  if (injectedConfig === null) cachedConfig = undefined;
}

function readConfigFile(): MinimalModeConfig {
  const path = existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_ALTERNATE;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const mode: FeatureMode =
      raw.mode === "on" || raw.mode === "off" || raw.mode === "auto" ? raw.mode : DEFAULT_CONFIG.mode;
    let patterns = DEFAULT_CONFIG.deepseekPatterns;
    if (Array.isArray(raw.deepseekPatterns) && raw.deepseekPatterns.length > 0) {
      const compiled: RegExp[] = [];
      for (const p of raw.deepseekPatterns) {
        try {
          compiled.push(new RegExp(String(p), "i"));
        } catch {
          // Skip malformed patterns instead of failing the gate.
        }
      }
      if (compiled.length > 0) patterns = compiled;
    }
    let whitelist = DEFAULT_CONFIG.whitelist;
    if (Array.isArray(raw.whitelist) && raw.whitelist.every((w) => typeof w === "string")) {
      whitelist = raw.whitelist as string[];
    }
    return { mode, deepseekPatterns: patterns, whitelist };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function loadConfig(): MinimalModeConfig {
  if (injectedConfig) return injectedConfig;
  if (!cachedConfig) cachedConfig = readConfigFile();
  return cachedConfig;
}

/** Test-only config injection. */
export function _setConfigForTesting(config: MinimalModeConfig | null): void {
  injectedConfig = config;
  cachedConfig = config ?? undefined;
}

export function isDeepSeekModel(model: GatableModel | null | undefined): boolean {
  if (!model) return false;
  const { deepseekPatterns } = loadConfig();
  const haystacks = [model.id, model.provider, model.name].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return deepseekPatterns.some((pattern) => haystacks.some((h) => pattern.test(h)));
}

/** Whether minimal mode applies to this model right now. */
export function isMinimalActive(model: GatableModel | null | undefined): boolean {
  const { mode } = loadConfig();
  if (mode === "off") return false;
  if (mode === "on") return true;
  return isDeepSeekModel(model);
}

/**
 * The full allowed set for a minimal model: active-set core + whitelist +
 * tools discovered via tool_search (they load on demand and must survive
 * the gate's sweeps).
 */
export function allowedTools(model: GatableModel, discovered?: ReadonlySet<string>): ReadonlySet<string> {
  const { whitelist } = loadConfig();
  const set = new Set<string>([...MINIMAL_CORE_TOOLS, ...whitelist]);
  for (const name of discovered ?? []) set.add(name);
  return set;
}

/** The tool_search name, owned by this gate outside minimal mode. */
export const TOOL_SEARCH_OWNED_NAME = "tool_search";

/**
 * Compute the desired active set. Returns null when nothing should change.
 *
 * - mode off: inert.
 * - minimal model: keep only allowed tools that are already active, then
 *   ensure the core tools (bash, str_replace_editor, tool_search) are
 *   present — they are always registered while this extension is installed
 *   together with pi-str-replace-editor. Whitelist tools are kept only when
 *   already active (never force-added, so a disabled package stays disabled).
 * - non-minimal model: remove tool_search, touch nothing else.
 */
export function desiredActiveTools(
  model: GatableModel | null | undefined,
  currentActive: readonly string[],
  discovered?: ReadonlySet<string>,
): string[] | null {
  if (loadConfig().mode === "off") return null;

  if (isMinimalActive(model)) {
    const allowed = allowedTools(model ?? {}, discovered);
    const next = currentActive.filter((name) => allowed.has(name));
    for (const core of MINIMAL_CORE_TOOLS) {
      if (!next.includes(core)) next.push(core);
    }
    return sortedEquals(next, currentActive) ? null : next;
  }

  // Non-minimal: this gate only owns its discovery tool (tool_search);
  // everything else stays.
  const managed = [TOOL_SEARCH_OWNED_NAME];
  if (!currentActive.some((name) => managed.includes(name))) return null;
  const next = currentActive.filter((name) => !managed.includes(name));
  return sortedEquals(next, currentActive) ? null : next;
}

/**
 * Defense-in-depth blocking. Never blocks the names owned by
 * pi-str-replace-editor (read/edit/write/grep/find/ls) — its block messages
 * are better; the active-set swap above still removes them for minimal models.
 */
export function shouldBlockTool(
  toolName: string,
  model: GatableModel | null | undefined,
  discovered?: ReadonlySet<string>,
): boolean {
  if (loadConfig().mode === "off") return false;
  if (!isMinimalActive(model)) {
    return toolName === TOOL_SEARCH_OWNED_NAME;
  }
  if (STR_REPLACE_OWNED.includes(toolName as (typeof STR_REPLACE_OWNED)[number])) return false;
  return !allowedTools(model ?? {}, discovered).has(toolName);
}

function sortedEquals(next: string[], current: readonly string[]): boolean {
  const nextSorted = [...next].sort().join("\0");
  const currentSorted = [...current].sort().join("\0");
  return nextSorted === currentSorted;
}
