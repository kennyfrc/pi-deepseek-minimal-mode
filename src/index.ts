/**
 * Strict-by-default DeepSeek Harness composition for Pi.
 *
 * Strict exposes the frozen reference persona and two-tool schema. Augmented
 * keeps the same persona, inlines complete live schemas for registered names
 * in `whitelist`, and can carry durable AGENTS and skill context. Both modes
 * use direct tool definitions.
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
import { projectMinimalPayload } from "./harness-payload.js";
import {
  allowedTools,
  desiredActiveTools,
  isMinimalActive,
  loadConfig,
  registeredWhitelistTools,
  resetConfigCache,
  shouldBlockTool,
  type GatableModel,
} from "./gate.js";

const STATUS_KEY = "pi-deepseek-minimal-mode:active";

let currentModel: GatableModel | undefined;
let sessionCwd = process.cwd();

/** The live tool fields this extension serializes into the durable context. */
export interface SerializedAgentTool {
  name: string;
  description: string;
  parameters?: unknown;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Serialize the extra tools into an `<available_tools>` block that mirrors the
 * skills block style. The parameter schema ships as JSON Schema text.
 */
function formatToolsForPrompt(tools: ReadonlyArray<SerializedAgentTool>): string {
  if (tools.length === 0) return "";
  const lines: string[] = [
    "",
    "The following tools extend the minimal core during this session.",
    "Their parameter schemas are JSON Schema.",
    "",
    "<available_tools>",
  ];
  for (const tool of tools) {
    lines.push("  <tool>");
    lines.push(`    <name>${escapeXml(tool.name)}</name>`);
    lines.push(`    <description>${escapeXml(tool.description)}</description>`);
    lines.push(`    <parameters>${JSON.stringify(tool.parameters ?? {})}</parameters>`);
    lines.push("  </tool>");
  }
  lines.push("</available_tools>");
  return lines.join("\n");
}

export function buildAgentsMdContent(
  files: ReadonlyArray<{ path: string; content: string }>,
  skills: ReadonlyArray<Skill>,
  tools: ReadonlyArray<SerializedAgentTool> = [],
): string | null {
  const parts: string[] = [];
  if (files.length > 0) parts.push(files.map((file) => `${file.path}:\n${file.content}`).join("\n\n"));
  const skillsBlock = formatSkillsForPrompt([...skills]);
  if (skillsBlock.trim().length > 0) parts.push(skillsBlock.trim());
  const toolsBlock = formatToolsForPrompt(tools);
  if (toolsBlock.trim().length > 0) parts.push(toolsBlock.trim());
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function registeredNames(pi: ExtensionAPI): ReadonlySet<string> {
  return new Set(pi.getAllTools().map((tool) => tool.name));
}

function describeMode(model: GatableModel | undefined): string {
  if (!isMinimalActive(model)) return "minimal mode off";
  return `minimal mode ${loadConfig().profile}`;
}

/** Recompute catalog membership on every lifecycle sweep. */
function applyGating(pi: ExtensionAPI, ctx: ExtensionContext): void {
  currentModel = (ctx.model as GatableModel | undefined) ?? currentModel;
  const next = desiredActiveTools(currentModel, pi.getActiveTools(), registeredNames(pi));
  if (next) pi.setActiveTools(next);
  if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, describeMode(currentModel));
}

export default function minimalModeExtension(pi: ExtensionAPI): void {
  if (process.env.PI_MINIMAL_AGENTS_MD !== "0") {
    registerReminder(pi, {
      id: "agents-md",
      label: "agents-md",
      lifetime: "durable",
      on: "session:start",
      content: (ctx) => {
        const config = loadConfig();
        if (!isMinimalActive(currentModel) || config.profile !== "augmented") return null;
        let skills: Skill[] = [];
        if (process.env.PI_MINIMAL_SKILLS !== "0") {
          try {
            skills = loadSkills({
              cwd: sessionCwd,
              agentDir: undefined as unknown as string,
              skillPaths: [],
              includeDefaults: true,
            }).skills;
          } catch {
            skills = [];
          }
        }
        const names = registeredWhitelistTools(config, registeredNames(pi));
        const byName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
        const tools = names.flatMap((name) => {
          const tool = byName.get(name);
          return tool ? [tool] : [];
        });
        return buildAgentsMdContent(ctx.contextFiles ?? [], skills, tools);
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    sessionCwd = ctx.cwd;
    resetConfigCache();
    applyGating(pi, ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    applyGating(pi, ctx);
  });

  pi.on("turn_start", (_event, ctx) => {
    applyGating(pi, ctx);
  });

  pi.on("context", (_event, ctx) => {
    applyGating(pi, ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const model = (ctx.model as GatableModel | undefined) ?? currentModel;
    if (!isMinimalActive(model)) return undefined;
    const payload = event.payload as Parameters<typeof projectMinimalPayload>[0] | null;
    if (!payload) return undefined;
    const changed = projectMinimalPayload(payload, loadConfig(), registeredNames(pi));
    if (process.env.PI_MINIMAL_MODE_DUMP) {
      try {
        appendFileSync(process.env.PI_MINIMAL_MODE_DUMP, `\n===REQUEST===\n${JSON.stringify(payload)}`);
      } catch {
        // Instrumentation must not alter request delivery.
      }
    }
    return changed ? (payload as unknown) : undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    const catalog = registeredNames(pi);
    if (!shouldBlockTool(event.toolName, ctx.model, catalog)) return undefined;
    const names = [...allowedTools((ctx.model as GatableModel | undefined) ?? {}, catalog)];
    return {
      block: true as const,
      reason: `This model runs in ${loadConfig().profile} minimal mode. Available tools: ${names.join(", ")}.`,
    };
  });

  pi.on("session_shutdown", () => {
    resetConfigCache();
  });
}

export {
  allowedTools,
  DEFAULT_DEEPSEEK_PATTERNS,
  DEFAULT_WHITELIST,
  desiredActiveTools,
  isDeepSeekModel,
  isMinimalActive,
  loadConfig,
  MINIMAL_CORE_TOOLS,
  parseMinimalModeConfig,
  registeredWhitelistTools,
  resetConfigCache,
  shouldBlockTool,
  STR_REPLACE_OWNED,
  _setConfigForTesting,
  type FeatureMode,
  type GatableModel,
  type MinimalModeConfig,
  type MinimalProfile,
} from "./gate.js";
