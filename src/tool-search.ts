/**
 * pi-deepseek-minimal-mode — tool_search.
 *
 * The Claude Code tool-search mechanic, ported for pi's minimal mode: the
 * payload carries only bash + str_replace_editor, but the full tool catalog
 * stays discoverable. A natural-language query is ranked with BM25 over
 * tool names (boosted) and descriptions — the same approach as Claude
 * Code's tool_search_tool_bm25 — and the top matches are returned with
 * one-line descriptions and their argument shapes, and ACTIVATED: the model
 * then calls them by name, still without their definitions in the payload.
 * Only what gets used costs context.
 *
 * Claude Code reference:
 *  - platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
 *  - code.claude.com/docs/en/agent-sdk/tool-search
 *    ("searches the tool catalog and loads only the tools it needs",
 *     default limit 5, BM25 for natural-language queries)
 */
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const toolSearchParameters = Type.Object({
  query: Type.String({
    description: "Natural-language description of the capability you need, e.g. 'search the web' or 'fetch a web page'.",
  }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      description: "Maximum number of tools to return (default 5).",
    }),
  ),
});

export type ToolSearchParameters = Static<typeof toolSearchParameters>;

export const TOOL_SEARCH_DESCRIPTION = `Find tools beyond your always-available set. Use this when you need a capability you do not have: web search, fetching pages, browser control, reminders, and so on. Search with natural language; the best matching tools are returned with one-line descriptions and become available from your next step.

Only the tools you find are loaded into context, so search only when you actually need a new capability.`;

export const TOOL_SEARCH_NAME = "tool_search";

/** Tools the model always has in minimal mode; never returned by search. */
export const DEFAULT_SEARCH_EXCLUDES: readonly string[] = ["bash", "str_replace_editor", TOOL_SEARCH_NAME];

/** A tool entry in the searchable catalog. */
export interface SearchableTool {
  name: string;
  description?: string;
  /** Input schema; surfaced in results so the tool can be called by name without a definition in the payload. */
  parameters?: unknown;
}

/** Compact argument-shape hint (property: type pairs) from a tool's schema. */
function argumentShape(parameters: unknown): string | undefined {
  if (!parameters || typeof parameters !== "object") return undefined;
  const record = parameters as Record<string, unknown>;
  const props = record.properties;
  if (!props || typeof props !== "object") return undefined;
  const entries: string[] = [];
  for (const [name, schema] of Object.entries(props as Record<string, unknown>)) {
    if (!schema || typeof schema !== "object") continue;
    const s = schema as Record<string, unknown>;
    let type = s.type;
    if (Array.isArray(type)) type = type.join("|");
    if (typeof type !== "string" && (s as { enum?: unknown }).enum) type = "enum";
    if (typeof type !== "string") continue;
    const required = Array.isArray(record.required) && (record.required as string[]).includes(name);
    entries.push(`${name}: ${type}${required ? " (required)" : ""}`);
  }
  if (entries.length === 0) return undefined;
  const shape = entries.join(", ");
  return shape.length > 200 ? `${shape.slice(0, 197)}...` : shape;
}

/** Called with the names of tools the search activated. */
export type ToolSearchActivate = (names: string[]) => void;

/** First line of a tool description (the model-facing one-liner). */
function oneLineDescription(tool: SearchableTool): string {
  const text = tool.description ?? "";
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim();
}

// ---- BM25 over tool name + description -------------------------------------
// Claude Code uses BM25 for natural-language queries. k1/b follow the
// standard defaults; name terms count twice because the name is the strongest
// signal (consistent with Claude's namespacing guidance).

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "to", "of", "with", "from", "in", "on", "at", "by",
  "use", "used", "using", "when", "you", "your", "it", "is", "are", "be", "this", "that", "as",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function buildIndex(tools: SearchableTool[]): {
  docs: Map<string, { nameTerms: string[]; descTerms: string[] }>;
  docLengths: Map<string, number>;
  docFrequency: Map<string, number>;
  avgLength: number;
} {
  const docs = new Map<string, { nameTerms: string[]; descTerms: string[] }>();
  const docLengths = new Map<string, number>();
  const docFrequency = new Map<string, number>();
  let totalLength = 0;

  for (const tool of tools) {
    const nameTerms = tokenize(tool.name);
    const descTerms = tokenize(oneLineDescription(tool));
    docs.set(tool.name, { nameTerms, descTerms });
    const length = nameTerms.length + descTerms.length;
    docLengths.set(tool.name, length);
    totalLength += length;
    const seen = new Set([...nameTerms, ...descTerms]);
    for (const term of seen) docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1);
  }

  return { docs, docLengths, docFrequency, avgLength: tools.length === 0 ? 1 : totalLength / tools.length };
}

const K1 = 1.2;
const B = 0.75;

function scoreTool(
  queryTerms: string[],
  tool: SearchableTool,
  index: { docs: Map<string, { nameTerms: string[]; descTerms: string[] }>; docLengths: Map<string, number>; docFrequency: Map<string, number>; avgLength: number },
): number {
  const doc = index.docs.get(tool.name);
  if (!doc) return 0;
  const length = index.docLengths.get(tool.name) ?? 1;
  const termCounts = new Map<string, number>();
  for (const term of doc.nameTerms) termCounts.set(term, (termCounts.get(term) ?? 0) + 2); // name boost
  for (const term of doc.descTerms) termCounts.set(term, (termCounts.get(term) ?? 0) + 1);

  let score = 0;
  for (const term of new Set(queryTerms)) {
    const tf = termCounts.get(term) ?? 0;
    if (tf === 0) continue;
    const df = index.docFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (index.docs.size - df + 0.5) / (df + 0.5));
    score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / index.avgLength));
  }
  return score;
}

export interface ToolSearchResult {
  /** Ranked matches. */
  matches: SearchableTool[];
  /** Names that were activated (not counting already-active ones). */
  activated: string[];
}

export function searchTools(
  query: string,
  catalog: readonly SearchableTool[],
  options: { limit?: number; excludes?: ReadonlySet<string>; alreadyActive?: ReadonlySet<string> } = {},
): ToolSearchResult {
  const limit = Math.min(options.limit ?? 5, 20);
  const excludes = options.excludes ?? new Set(DEFAULT_SEARCH_EXCLUDES);
  const alreadyActive = options.alreadyActive ?? new Set();
  const candidates = catalog.filter((tool) => !excludes.has(tool.name) && !alreadyActive.has(tool.name));

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || candidates.length === 0) return { matches: [], activated: [] };

  const index = buildIndex(candidates);
  const scored = candidates
    .map((tool) => ({ tool, score: scoreTool(queryTerms, tool, index) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit);

  return { matches: scored.map((entry) => entry.tool), activated: scored.map((entry) => entry.tool.name) };
}

export function formatToolSearchResult(query: string, result: ToolSearchResult): string {
  if (result.matches.length === 0) {
    return `No tools found for "${query}". Try different keywords (e.g. "web", "browser", "image") or ask more specifically.`;
  }
  const lines = result.matches.map((tool) => {
    const shape = argumentShape(tool.parameters);
    const line = `- ${tool.name}: ${oneLineDescription(tool)}`;
    return shape ? `${line}\n  args: ${shape}` : line;
  });
  return [
    `Tools matching "${query}":`,
    ...lines,
    "",
    "Call these tools by name on your next step; their definitions are not in your tool list.",
  ].join("\n");
}

export interface ToolSearchOptions {
  /** Catalog provider; production default reads pi.getAllTools(). */
  getCatalog?: () => SearchableTool[];
  /** Extra names to never return. */
  excludes?: ReadonlySet<string>;
  /** Called with newly-activated tool names (production: pi.setActiveTools). */
  activate?: ToolSearchActivate;
  /** Current active set provider (skips already-active tools). */
  getActive?: () => readonly string[];
}

export function createToolSearchTool(options: ToolSearchOptions = {}): ToolDefinition {
  return {
    name: TOOL_SEARCH_NAME,
    label: "tool_search",
    description: TOOL_SEARCH_DESCRIPTION,
    parameters: toolSearchParameters,
    promptGuidelines: [
      "Use tool_search when you need a capability beyond bash and str_replace_editor: search with natural language, then use the found tools on your next step.",
      "Search only when you actually need a new capability; found tools stay loaded for the rest of the session.",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const args = params as ToolSearchParameters;
      const query = args.query;
      if (!query || query.trim().length === 0) throw new Error("query must be a non-empty string");

      const catalog = options.getCatalog?.() ?? getCatalogFromPi(ctx);
      const result = searchTools(query, catalog, {
        limit: args.limit,
        excludes: options.excludes,
        alreadyActive: new Set(options.getActive?.() ?? []),
      });
      if (result.activated.length > 0) options.activate?.(result.activated);
      return {
        content: [{ type: "text", text: formatToolSearchResult(query, result) }],
        details: { kind: "tool_search", query, activated: result.activated },
      };
    },
  };
}

/** Read the catalog out of the extension context's pi handle (test seam). */
function getCatalogFromPi(ctx: ExtensionContext): SearchableTool[] {
  // ExtensionContext does not expose getAllTools directly; the tool is
  // created with an explicit getCatalog in production wiring (index.ts).
  // This fallback keeps the standalone tool usable in bare contexts.
  const pi = (ctx as unknown as { pi?: { getAllTools?: () => Array<{ name: string; description?: string }> } }).pi;
  if (pi?.getAllTools) return pi.getAllTools().map((t) => ({ name: t.name, description: t.description }));
  return [];
}
