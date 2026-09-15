import { describe, expect, test } from "vitest";

import { TOOL_DEFINITIONS } from "../../src/index.js";

/**
 * Byte-size regression guard for review finding L8
 * (docs/internal/reviews/2026-09-14-inherited-project-review.md).
 *
 * Tool schemas are injected into every session's context on every MCP
 * connection, so keeping each tool's serialized JSON schema small directly
 * saves per-session tokens. Before the L8 cleanup, xedit-mcp's 17 tool
 * schemas totaled ~19.9 KB; several individual tools (xedit_find_records_by_pattern,
 * xedit_restart, xedit_create_child_record, xedit_start) carried
 * daemon-contract-version commentary ("contract 0.21 rejects limit > 100",
 * "Phase-15-style", etc.) and repeated not_ready/readiness boilerplate that
 * belonged in skills/xedit-automation/SKILL.md instead of every tool-list
 * response. That content was relocated there (see the SKILL.md sections
 * "Filtering records at scale", "Deep conflict + reference audits",
 * "Dual-mode search tools", and the r6 capability table), and descriptions
 * were trimmed to one sentence of purpose plus short (~<=15 word) parameter
 * hints.
 *
 * This test measures each tool's serialized {name, description, inputSchema}
 * exactly as it is returned by TOOL_DEFINITIONS (which server.setRequestHandler
 * for ListToolsRequestSchema returns verbatim — see src/index.ts).
 */

const DEFAULT_MAX_BYTES = 1200;

// xedit_find_records_by_pattern wraps records.apply_filter's real 14-parameter
// filter surface (parentFormId, signatures, 5 *Regex fields, 2 *Pattern
// fields, plus pagination/drainAll/compact/maxMatches). Its size is
// structural (parameter count and the mutual-exclusivity disambiguation
// between each *Regex/*Pattern pair), not description bloat -- every
// description on this tool is already <= ~8 words. Trimming further would
// remove disambiguation the task explicitly says to keep. See the size
// comment left in src/index.ts next to this tool's definition.
const KNOWN_STRUCTURAL_EXCEPTIONS: Record<string, number> = {
  xedit_find_records_by_pattern: 1950,
};

describe("xedit-mcp tool schema size (L8 regression guard)", () => {
  test("TOOL_DEFINITIONS is non-empty (sanity check)", () => {
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(0);
  });

  for (const tool of TOOL_DEFINITIONS) {
    test(`${tool.name} serialized schema stays under its byte budget`, () => {
      const bytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
      const max = KNOWN_STRUCTURAL_EXCEPTIONS[tool.name] ?? DEFAULT_MAX_BYTES;
      expect(bytes, `${tool.name} is ${bytes} bytes (budget ${max})`).toBeLessThanOrEqual(max);
    });
  }

  test("no tool outside the known-exceptions list silently grows past the default budget", () => {
    const offenders = TOOL_DEFINITIONS.filter((tool) => {
      const bytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
      const isKnownException = tool.name in KNOWN_STRUCTURAL_EXCEPTIONS;
      return !isKnownException && bytes > DEFAULT_MAX_BYTES;
    });
    expect(offenders.map((t) => t.name)).toEqual([]);
  });
});
