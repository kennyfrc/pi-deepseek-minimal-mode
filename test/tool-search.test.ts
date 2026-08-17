/**
 * tool_search tests: BM25 ranking, exclusions, limit, activation, and the
 * Claude-style result format.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_EXCLUDES,
  formatToolSearchResult,
  searchTools,
  type SearchableTool,
} from "../src/tool-search.js";

const CATALOG: SearchableTool[] = [
  { name: "bash", description: "Run shell commands." },
  { name: "str_replace_editor", description: "View and edit files." },
  { name: "tool_search", description: "Find tools." },
  { name: "web_search", description: "Search the current web. Pass argv as [query, ...flags]." },
  { name: "web_fetch", description: "Read a URL with the webfetch CLI. Pass argv as [url, ...flags]." },
  { name: "cdp", description: "Inspect and automate a live browser with the cdp CLI." },
  { name: "hwy", description: "Analyze prose readability with the hwy CLI." },
  { name: "ask_user", description: "Ask focused user questions." },
  { name: "todo", description: "Manage the session plan as a checklist." },
  { name: "memo", description: "Persistent memory for this workspace." },
  { name: "WebSearch", description: "Search the web for information. Use this when you need up-to-date information from the internet." },
];

describe("searchTools", () => {
  it("never returns the always-available core tools", () => {
    const result = searchTools("shell commands edit files", CATALOG, { limit: 10 });
    expect(result.matches.map((t) => t.name)).not.toContain("bash");
    expect(result.matches.map((t) => t.name)).not.toContain("str_replace_editor");
    expect(result.matches.map((t) => t.name)).not.toContain("tool_search");
  });

  it("ranks natural-language queries over name and description (BM25)", () => {
    const result = searchTools("search the web", CATALOG);
    const names = result.matches.map((t) => t.name);
    expect(names[0]).toMatch(/web_search|WebSearch/);
    expect(names).toContain("web_fetch");
  });

  it("surfaces the browser tool for browsing language", () => {
    const result = searchTools("control a browser", CATALOG);
    expect(result.matches.map((t) => t.name)).toContain("cdp");
  });

  it("respects the limit and caps it at 20", () => {
    const catalog = Array.from({ length: 30 }, (_, i) => ({
      name: `tool_${i}`,
      description: `capability ${i} for testing limit`,
    }));
    expect(searchTools("capability", catalog, { limit: 3 }).matches).toHaveLength(3);
    expect(searchTools("capability", catalog, { limit: 50 }).matches).toHaveLength(20);
  });

  it("skips already-active tools and applies extra excludes", () => {
    const result = searchTools("web", CATALOG, {
      limit: 10,
      alreadyActive: new Set(["web_search"]),
      excludes: new Set([...DEFAULT_SEARCH_EXCLUDES, "WebSearch"]),
    });
    const names = result.matches.map((t) => t.name);
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("WebSearch");
    expect(names).toContain("web_fetch");
  });

  it("returns activated names alongside matches", () => {
    const result = searchTools("web", CATALOG, { limit: 2 });
    expect(result.activated).toEqual(result.matches.map((t) => t.name));
  });

  it("handles empty queries and empty catalogs", () => {
    expect(searchTools("   ", CATALOG)).toEqual({ matches: [], activated: [] });
    expect(searchTools("web", [])).toEqual({ matches: [], activated: [] });
  });

  it("a no-match query returns nothing", () => {
    expect(searchTools("zzzzz none such", CATALOG).matches).toHaveLength(0);
  });
});

describe("formatToolSearchResult", () => {
  it("formats matches as name + one-line description with the activation note", () => {
    const result = searchTools("web", CATALOG, { limit: 2 });
    const text = formatToolSearchResult("web", result);
    expect(text).toContain('Tools matching "web":');
    for (const tool of result.matches) {
      expect(text).toContain(`- ${tool.name}:`);
    }
    expect(text).toContain("Call these tools by name on your next step; their definitions are not in your tool list.");
  });

  it("surfaces argument shapes so found tools can be called by name", () => {
    const result = searchTools("web", [
      { name: "web_search", description: "Search the web.", parameters: { type: "object", properties: { query: { type: "string" }, count: { type: "integer" } }, required: ["query"] } },
    ], { excludes: new Set() });
    const text = formatToolSearchResult("web", result);
    expect(text).toContain("- web_search: Search the web.");
    expect(text).toContain("args: query: string (required), count: integer");
  });

  it("formats the no-match case with query suggestions", () => {
    const text = formatToolSearchResult("zzz", { matches: [], activated: [] });
    expect(text).toContain('No tools found for "zzz"');
    expect(text).toContain("Try different keywords");
  });
});
