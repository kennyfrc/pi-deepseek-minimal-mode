/**
 * pi-deepseek-minimal-mode — the DeepSeek Harness `minimal` preset for Pi.
 *
 * For DeepSeek-family models (config `~/.pi/agent/pi-deepseek-minimal-mode.json`,
 * default mode auto) the model-facing toolset collapses to:
 *
 *   bash + str_replace_editor (the only tools in the tools parameter)
 *
 * — the harness minimal environment. tool_search is registered and active
 * for call routing, but is never injected in the tools parameter and is
 * never advertised by an injected prompt: the harness minimal condition is
 * a clean first request (persona + two tool schemas, zero injected
 * context). If the model emits tool_search by name, discovered tools are
 * appended to the active set (callable by name) for the rest of the session
 * but never enter the payload either. Everything else is removed from the
 * active set and blocked at tool_call. Non-deepseek models keep their full
 * set; only tool_search is removed.
 *
 * Injected context: the ONLY sanctioned injections are the durable
 * session:start reminders below — the `agents-md` workspace-context block
 * and the one-shot `tool-search` nudge. They are PERSISTED as a hidden
 * session message placed immediately before the session's FIRST user prompt
 * (user-message placement keeps the RL register; system-prompt placement
 * flips it, A/B-verified against api.deepseek.com) and replay in every later
 * request and on resume — same <system_reminder> envelope, user-role wire
 * shape, durable="true" marker. No transient turn:start contract prompt:
 * re-injected reminder text breaks the anchor (community repro: 0/9 with a
 * skill digest present), and every other extension's transient reminder
 * traffic is stripped from the wire.
 */
import { appendFileSync } from "node:fs";
import {
  formatSkillsForPrompt,
  loadSkills,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { registerReminder } from "@kennyfrc/pi-system-reminders";
import { createToolSearchTool } from "./tool-search.js";
import { projectMinimalPayload, harnessTools } from "./harness-payload.js";
import {
  isMinimalActive,
  loadConfig,
  resetConfigCache,
  shouldBlockTool,
  TOOL_SEARCH_OWNED_NAME,
  desiredActiveTools,
  type GatableModel,
} from "./gate.js";

const STATUS_KEY = "pi-deepseek-minimal-mode:active";

/**
 * The reminder is the ONLY place tool_search is injected for the model: it
 * never appears in the tools parameter. It carries the call signature so
 * the model can invoke tool_search by name; found tools are also called by
 * name, guided by the result text (names + argument shapes).
 */
let currentModel: GatableModel | undefined;

/** Working directory captured at session_start, used for project skills. */
let sessionCwd = process.cwd();

/**
 * The one-shot tool-discovery nudge, delivered as a durable session:start
 * reminder: prefer searching for an existing tool over improvising with
 * bash. Short enough to amortize across the session; injected ONCE.
 */
export const TOOL_SEARCH_NUDGE_TEXT = [
  "Before exploring solutions or improvising with bash, search for an existing tool: emit a tool call with name \"tool_search\" and arguments {\"query\": \"what you need in a few words\"}.",
  "It returns matching tools with names and argument shapes; call those tools by name on your next step. Prefer an existing tool over raw bash exploration.",
].join("\n");

/**
 * Build the agents-md reminder body: context files first, then the
 * available-skills catalog (pi's standard protocol block, the same text the
 * system prompt would carry). tool_search indexes tools only, so this block
 * is the model's only way to discover skills in minimal mode. Returns null
 * when there is nothing to inject.
 */
export function buildAgentsMdContent(
  files: ReadonlyArray<{ path: string; content: string }>,
  skills: ReadonlyArray<Skill>,
): string | null {
  const parts: string[] = [];
  if (files.length > 0) {
    parts.push(files.map((f) => `${f.path}:\n${f.content}`).join("\n\n"));
  }
  const skillsBlock = formatSkillsForPrompt([...skills]);
  if (skillsBlock.trim().length > 0) {
    parts.push(skillsBlock.trim());
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

/**
 * Tools discovered via tool_search. They stay callable for the rest of the
 * session and must survive the gate's turn_start/context sweeps and the
 * wire-payload strip. Reset per session.
 */
let discoveredTools: Set<string> = new Set();

function describeMode(model: GatableModel | undefined): string {
  if (loadConfig().mode === "off") return "minimal mode off";
  return isMinimalActive(model) ? "minimal mode on (bash + str_replace_editor)" : "minimal mode off";
}

/**
 * Apply the minimal toolset swap. Reads the live active set, computes the
 * desired set, and calls setActiveTools only when it differs. Idempotent and
 * safe next to pi-str-replace-editor: both compute from the current set.
 */
function applyGating(pi: ExtensionAPI, ctx: ExtensionContext): void {
  currentModel = ctx.model ?? currentModel;
  const current = pi.getActiveTools();
  const next = desiredActiveTools(currentModel, current, discoveredTools);
  if (!next) return;
  pi.setActiveTools(next);
  if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, describeMode(currentModel));
}

export default function minimalModeExtension(pi: ExtensionAPI): void {
  // The discovery channel is registered first: it is the one always-visible
  // tool beyond bash + str_replace_editor, and the gate keeps it active.
  pi.registerTool(
    createToolSearchTool({
      getCatalog: () =>
        pi.getAllTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: (tool as { parameters?: unknown }).parameters,
        })),
      getActive: () => pi.getActiveTools(),
      activate: (names) => {
        for (const name of names) discoveredTools.add(name);
        const current = pi.getActiveTools();
        const next = [...current, ...names.filter((name) => !current.includes(name))];
        if (next.length !== current.length) pi.setActiveTools(next);
      },
    }),
  );

  // kimi-interface WebSearch removed: pi already ships web_search and
  // web_fetch; tool_search surfaces them on demand, so a second search tool
  // would only duplicate the surface and burn context.
  //
  // NO injected operating-contract prompt. The harness minimal condition is
  // a CLEAN first request: persona + two tool schemas, zero injected
  // context (community repro: an injected reminder/skill digest breaks the
  // RL anchor). tool_search stays registered and callable by name, but
  // nothing advertises it; discovery is model-initiated or not at all.

  // Durable session:start reminder: AGENTS.md (and any other context files pi
  // loaded) is PERSISTED ONCE as a hidden session message placed immediately
  // before the session's FIRST user prompt, wrapped in the merged
  // system_reminder envelope, and replays in every subsequent request and on
  // resume. It stays out of the system prompt — the wire persona is the
  // harness persona — so the RL register survives (verified: system-prompt
  // placement of this content flips the thinking trace to full grammar;
  // user-message placement keeps it). Non-minimal models get these files
  // through the normal system prompt, so the reminder stays silent. Escape
  // hatch: PI_MINIMAL_AGENTS_MD=0.
  //
  // The available-skills catalog is appended to the same block (the skills
  // protocol pi normally carries in the system prompt): tool_search indexes
  // tools only, so without this block the model can never discover skills.
  // It uses pi's own loader + formatter, so disableModelInvocation skills
  // stay excluded. Escape hatch: PI_MINIMAL_SKILLS=0.
  if (process.env.PI_MINIMAL_AGENTS_MD !== "0")
  registerReminder(pi, {
    id: "agents-md",
    label: "agents-md",
    lifetime: "durable",
    on: "session:start",
    content: (ctx) => {
      if (!isMinimalActive(currentModel)) return null;
      let skills: Skill[] = [];
      if (process.env.PI_MINIMAL_SKILLS !== "0") {
        try {
          skills = loadSkills({
            cwd: sessionCwd,
            // undefined -> pi's own getAgentDir() default (env override or ~/.pi/agent)
            agentDir: undefined as unknown as string,
            skillPaths: [],
            includeDefaults: true,
          }).skills;
        } catch (err) {
          // skill discovery must never take down the reminder
          skills = [];
        }
      }
      return buildAgentsMdContent(ctx.contextFiles ?? [], skills);
    },
  });

  // Durable session:start reminder: the one-shot tool_search nudge — search
  // for an existing tool before improvising with bash. PERSISTED once before
  // the session's first user prompt, same as agents-md, so it stays in
  // context for every later prompt and on resume; NOT re-derived every turn
  // (that transient prompt broke the clean RL anchor, so it was removed).
  registerReminder(pi, {
    id: "tool-search",
    label: "tool-search",
    lifetime: "durable",
    on: "session:start",
    content: () => (isMinimalActive(currentModel) ? TOOL_SEARCH_NUDGE_TEXT : null),
  });

  pi.on("session_start", (_event, ctx) => {
    sessionCwd = ctx.cwd;
    resetConfigCache();
    discoveredTools = new Set();
    applyGating(pi, ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    applyGating(pi, ctx);
  });

  // pi's tool-refresh machinery re-adds newly registered tools to the active
  // set (e.g. the pi-mcp-adapter registers its gateway tool after
  // session_start) without firing an extension event. Two sweeps close the
  // race:
  // 1. turn_start — re-apply the idempotent gate before each turn.
  // 2. context — re-apply right before each request is assembled.
  pi.on("turn_start", (_event, ctx) => {
    applyGating(pi, ctx);
  });

  pi.on("context", (_event, ctx) => {
    applyGating(pi, ctx);
  });

  // Wire projection: the harness minimal SHAPE — its persona as the whole
  // system prompt, exactly two tools [bash, str_replace_editor], and its wire
  // params — regardless of what pi or other extensions put into the active
  // set or the base system prompt (pi rebuilds the prompt on every
  // setActiveTools; tool_search/discovered tools are callable by name but
  // never appear in the payload). The tool entries themselves are pi's live
  // ones. The sanctioned delta is pi's system_reminder traffic, which lives
  // in user messages and is untouched here.
  pi.on("before_provider_request", (event, ctx) => {
    const model = (ctx.model as GatableModel | undefined) ?? currentModel;
    if (!isMinimalActive(model)) return undefined;
    const payload = event.payload as Parameters<typeof projectMinimalPayload>[0] | null;
    if (!payload) return undefined;
    // Wire tools: pi's live bash + str_replace_editor entries by default
    // (the model keeps the full pi surface: timeout/background/job/action,
    // the editor's pi notes). PI_MINIMAL_WIRE_VARIANT=harness forces the
    // frozen RL fixture pair for byte-parity experiments.
    const wireTools = process.env.PI_MINIMAL_WIRE_VARIANT === "harness" ? harnessTools() : undefined;
    const changed = projectMinimalPayload(payload, wireTools);
    if (process.env.PI_MINIMAL_MODE_DUMP) {
      try {
        appendFileSync(process.env.PI_MINIMAL_MODE_DUMP, "\n===REQUEST===\n" + JSON.stringify(payload));
      } catch {
        // instrumentation only
      }
    }
    return changed ? (payload as unknown) : undefined;
  });

  // Defense in depth: a minimal model calling any non-allowed tool gets
  // blocked with a pointer at the allowed set; a non-minimal model calling
  // tool_search gets pointed at its directly-available toolset. Names owned
  // by pi-str-replace-editor (read/edit/write/grep/find/ls) are left to its
  // block messages.
  pi.on("tool_call", (event, ctx) => {
    if (!shouldBlockTool(event.toolName, ctx.model, discoveredTools)) return undefined;
    if (event.toolName === TOOL_SEARCH_OWNED_NAME) {
      return {
        block: true as const,
        reason:
          "tool_search is a discovery tool for minimal mode only. This model already has its full toolset available directly.",
      };
    }
    return {
      block: true as const,
      reason:
        "This model runs in minimal mode: your tools are bash and str_replace_editor. " +
        "Call tool_search with a natural-language query to find the tool you need; matches become callable by name on your next step.",
    };
  });

  pi.on("session_shutdown", () => {
    resetConfigCache();
  });
}

// Re-exported for tests / programmatic use.
export {
  createToolSearchTool,
  DEFAULT_SEARCH_EXCLUDES,
  formatToolSearchResult,
  searchTools,
  TOOL_SEARCH_DESCRIPTION,
  TOOL_SEARCH_NAME,
  toolSearchParameters,
  type SearchableTool,
  type ToolSearchActivate,
  type ToolSearchOptions,
  type ToolSearchParameters,
  type ToolSearchResult,
} from "./tool-search.js";
export {
  allowedTools,
  DEFAULT_DEEPSEEK_PATTERNS,
  DEFAULT_WHITELIST,
  desiredActiveTools,
  isDeepSeekModel,
  isMinimalActive,
  loadConfig,
  MINIMAL_CORE_TOOLS,
  resetConfigCache,
  shouldBlockTool,
  STR_REPLACE_OWNED,
  WIRE_CORE_TOOLS,
  wireAllowedTools,
  _setConfigForTesting,
  type FeatureMode,
  type GatableModel,
  type MinimalModeConfig,
} from "./gate.js";
