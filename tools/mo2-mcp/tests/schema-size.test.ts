import { describe, expect, it } from "vitest";
import { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { normalizeMcpInputSchema } from "../src/index.js";
import { getAllTools } from "../src/tool-registry.js";

/**
 * Byte-size regression guard for review finding L8
 * (docs/internal/reviews/2026-09-14-inherited-project-review.md).
 *
 * Tool schemas are injected into every session's context on every MCP
 * connection, so keeping each tool's serialized JSON schema small directly
 * saves per-session tokens. This measures each tool's wire schema the same
 * way src/index.ts's ListToolsRequestSchema handler builds it: zodToJsonSchema
 * (openApi3 target) + normalizeMcpInputSchema.
 *
 * Unlike xedit-mcp, mo2-mcp's tool descriptions never carried daemon-contract
 * commentary or repeated readiness boilerplate -- they were already one
 * concise sentence each, and no tool uses per-field zod .describe() at all.
 * mo2_install's description was trimmed (dropped an internal "Pattern A:
 * sidecar parse/extract -> broker createMod -> ..." implementation-detail
 * sentence, already documented in docs/internal/plans/2026-06-14-mo2-mcp-*)
 * and mo2_configure_executable's was tightened, but the latter's size is
 * structural: its plan/apply discriminated union merges the customExecutables
 * `entry` and `updates` object shapes (9 properties each) at the top level,
 * and there are no field descriptions left to cut without changing the
 * schema shape (forbidden by the L8 fix). It is allowlisted below.
 */

const DEFAULT_MAX_BYTES = 1200;

const KNOWN_STRUCTURAL_EXCEPTIONS: Record<string, number> = {
  mo2_configure_executable: 1400,
};

function wireSchemaFor(tool: ReturnType<typeof getAllTools>[number]): Record<string, unknown> {
  const rawSchema =
    tool.inputSchema instanceof ZodType
      ? (zodToJsonSchema(tool.inputSchema, { target: "openApi3" }) as Record<string, unknown>)
      : (tool.inputSchema as Record<string, unknown>);
  return normalizeMcpInputSchema(rawSchema);
}

describe("mo2-mcp tool schema size (L8 regression guard)", () => {
  const tools = getAllTools();

  it("registers the expected tool surface (sanity check for side-effect imports)", () => {
    expect(tools.length).toBeGreaterThanOrEqual(35);
  });

  for (const tool of tools) {
    it(`${tool.name} serialized schema stays under its byte budget`, () => {
      const inputSchema = wireSchemaFor(tool);
      const wireTool = { name: tool.name, description: tool.description, inputSchema };
      const bytes = Buffer.byteLength(JSON.stringify(wireTool), "utf8");
      const max = KNOWN_STRUCTURAL_EXCEPTIONS[tool.name] ?? DEFAULT_MAX_BYTES;
      expect(bytes, `${tool.name} is ${bytes} bytes (budget ${max})`).toBeLessThanOrEqual(max);
    });
  }

  it("no tool outside the known-exceptions list silently grows past the default budget", () => {
    const offenders = tools
      .filter((tool) => !(tool.name in KNOWN_STRUCTURAL_EXCEPTIONS))
      .filter((tool) => {
        const inputSchema = wireSchemaFor(tool);
        const bytes = Buffer.byteLength(
          JSON.stringify({ name: tool.name, description: tool.description, inputSchema }),
          "utf8",
        );
        return bytes > DEFAULT_MAX_BYTES;
      })
      .map((tool) => tool.name);
    expect(offenders).toEqual([]);
  });
});
