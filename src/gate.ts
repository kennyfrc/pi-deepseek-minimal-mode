/**
 * Profile parsing and direct tool policy for DeepSeek minimal mode.
 *
 * Strict is the safe default. It exposes only the two tools in the reference
 * Harness composition. Augmented adds registered tools named by `whitelist`.
 * Every augmented tool is direct: there is no discovery state or hidden call
 * path.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Minimal model fields used by this extension. */
export interface GatableModel {
  id?: string;
  provider?: string;
  name?: string;
  api?: string;
}

export type FeatureMode = "auto" | "on" | "off";
export type MinimalProfile = "strict" | "augmented";

export const DEFAULT_DEEPSEEK_PATTERNS: readonly RegExp[] = [/deepseek/i];
export const DEFAULT_WHITELIST: readonly string[] = [];
export const MINIMAL_CORE_TOOLS: readonly string[] = ["bash", "str_replace_editor"];

/**
 * Sentinel in `whitelist` that expands to every registered tool except the
 * core pair, the str_replace_editor-owned trio, and the GPT-only file tool.
 * This makes a DeepSeek augmented session carry the same tool surface a
 * normal (non-DeepSeek) session gets, minus the file-tool swaps applied for
 * DeepSeek (pi-str-replace-editor replaces read/edit/write; pi-apply-patch is
 * registered unconditionally but is GPT-family only).
 */
export const WHITELIST_ALL_SENTINEL = "*";

/** Names whose detailed block messages remain owned by pi-str-replace-editor. */
export const STR_REPLACE_OWNED = ["read", "edit", "write"] as const;

/**
 * Tools registered unconditionally by another extension but owned by a
 * different model family. pi-apply-patch keeps `apply_patch` active only for
 * GPT-family models; it is registered for every model, so it must never
 * surface in a DeepSeek augmented session even when explicit/all markers
 * would include it.
 */
export const DEEPSEEK_EXCLUDED_TOOLS: readonly string[] = ["apply_patch"] as const;

export interface MinimalModeConfig {
  mode: FeatureMode;
  profile: MinimalProfile;
  deepseekPatterns: readonly RegExp[];
  /** Ordered names whose complete live schemas are inlined in augmented mode. */
  whitelist: readonly string[];
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-deepseek-minimal-mode.json");
const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();

const DEFAULT_CONFIG: MinimalModeConfig = {
  mode: "auto",
  profile: "strict",
  deepseekPatterns: DEFAULT_DEEPSEEK_PATTERNS,
  whitelist: DEFAULT_WHITELIST,
};

let cachedConfig: MinimalModeConfig | undefined;
let injectedConfig: MinimalModeConfig | null = null;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`pi-deepseek-minimal-mode invariant: ${message}`);
}

function assertConfig(config: MinimalModeConfig): void {
  invariant(config.mode === "auto" || config.mode === "on" || config.mode === "off", "invalid mode");
  invariant(config.profile === "strict" || config.profile === "augmented", "invalid profile");
  invariant(config.deepseekPatterns.length > 0, "model pattern set must not be empty");
  invariant(config.deepseekPatterns.every((pattern) => pattern instanceof RegExp), "model patterns must be RegExp values");
  invariant(config.whitelist.every((name) => typeof name === "string"), "whitelist names must be strings");
}

/** Parse unknown config data into one valid, resolved policy. */
export function parseMinimalModeConfig(raw: unknown): MinimalModeConfig {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const mode: FeatureMode =
    record.mode === "on" || record.mode === "off" || record.mode === "auto" ? record.mode : DEFAULT_CONFIG.mode;
  const profile: MinimalProfile = record.profile === "augmented" ? "augmented" : "strict";

  let deepseekPatterns = DEFAULT_CONFIG.deepseekPatterns;
  if (Array.isArray(record.deepseekPatterns) && record.deepseekPatterns.length > 0) {
    const compiled: RegExp[] = [];
    for (const value of record.deepseekPatterns) {
      try {
        compiled.push(new RegExp(String(value), "i"));
      } catch {
        // A malformed entry does not invalidate the whole config.
      }
    }
    if (compiled.length > 0) deepseekPatterns = compiled;
  }

  const whitelist =
    Array.isArray(record.whitelist) && record.whitelist.every((name) => typeof name === "string")
      ? (record.whitelist as string[])
      : DEFAULT_CONFIG.whitelist;

  const config: MinimalModeConfig = { mode, profile, deepseekPatterns, whitelist };
  assertConfig(config);
  return config;
}

/** Drop the disk config cache so file edits apply on the next lifecycle read. */
export function resetConfigCache(): void {
  if (injectedConfig === null) cachedConfig = undefined;
}

function readConfigFile(): MinimalModeConfig {
  if (!existsSync(CONFIG_PATH)) return parseMinimalModeConfig(undefined);
  try {
    return parseMinimalModeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    return parseMinimalModeConfig(undefined);
  }
}

export function loadConfig(): MinimalModeConfig {
  if (injectedConfig) return injectedConfig;
  if (!cachedConfig) cachedConfig = readConfigFile();
  assertConfig(cachedConfig);
  return cachedConfig;
}

/** Test-only config injection. */
export function _setConfigForTesting(config: MinimalModeConfig | null): void {
  if (config) assertConfig(config);
  injectedConfig = config;
  cachedConfig = config ?? undefined;
}

export function isDeepSeekModel(model: GatableModel | null | undefined): boolean {
  if (!model) return false;
  const haystacks = [model.id, model.provider, model.name].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return loadConfig().deepseekPatterns.some((pattern) => haystacks.some((value) => pattern.test(value)));
}

export function isMinimalActive(model: GatableModel | null | undefined): boolean {
  const { mode } = loadConfig();
  if (mode === "off") return false;
  if (mode === "on") return true;
  return isDeepSeekModel(model);
}

/** Unique registered augmented extras in config order. */
export function registeredWhitelistTools(
  config: MinimalModeConfig,
  registeredNames: ReadonlySet<string>,
): string[] {
  assertConfig(config);
  if (config.profile === "strict") return [];

  const core = new Set<string>(MINIMAL_CORE_TOOLS);
  const swapOwned = new Set<string>(STR_REPLACE_OWNED);
  const deepseekExcluded = new Set<string>(DEEPSEEK_EXCLUDED_TOOLS);
  const seen = new Set<string>();
  const extras: string[] = [];
  const push = (name: string): void => {
    if (core.has(name) || swapOwned.has(name) || deepseekExcluded.has(name) || seen.has(name) || !registeredNames.has(name))
      return;
    seen.add(name);
    extras.push(name);
  };
  for (const name of config.whitelist) {
    if (name === WHITELIST_ALL_SENTINEL) {
      for (const registered of registeredNames) push(registered);
      continue;
    }
    push(name);
  }
  invariant(new Set(extras).size === extras.length, "augmented extra tools must be unique");
  return extras;
}

/** Direct callable names for the selected profile. */
export function allowedTools(
  model: GatableModel,
  registeredNames: ReadonlySet<string> = EMPTY_NAMES,
): ReadonlySet<string> {
  const config = loadConfig();
  const names = [...MINIMAL_CORE_TOOLS, ...registeredWhitelistTools(config, registeredNames)];
  invariant(!names.some((name, index) => names.indexOf(name) !== index), "allowed tools must be unique");
  return new Set(names);
}

/**
 * Compute the complete active set owned by this profile.
 *
 * Augmented force-adds registered whitelist names. This repairs names removed
 * by an earlier lifecycle gate and picks up late registrations on the next
 * turn_start or context sweep.
 */
export function desiredActiveTools(
  model: GatableModel | null | undefined,
  currentActive: readonly string[],
  registeredNames: ReadonlySet<string> = EMPTY_NAMES,
): string[] | null {
  if (loadConfig().mode === "off" || !isMinimalActive(model)) return null;

  const next = [...allowedTools(model ?? {}, registeredNames)];
  invariant(next[0] === "bash" && next[1] === "str_replace_editor", "core tool order changed");
  invariant(!next.includes("tool_search"), "discovery tool entered the direct surface");
  return orderedEquals(next, currentActive) ? null : next;
}

/** Defense-in-depth block policy for calls outside the selected direct set. */
export function shouldBlockTool(
  toolName: string,
  model: GatableModel | null | undefined,
  registeredNames: ReadonlySet<string> = EMPTY_NAMES,
): boolean {
  if (loadConfig().mode === "off" || !isMinimalActive(model)) return false;
  if (STR_REPLACE_OWNED.includes(toolName as (typeof STR_REPLACE_OWNED)[number])) return false;
  return !allowedTools(model ?? {}, registeredNames).has(toolName);
}

function orderedEquals(next: readonly string[], current: readonly string[]): boolean {
  return next.length === current.length && next.every((name, index) => current[index] === name);
}
