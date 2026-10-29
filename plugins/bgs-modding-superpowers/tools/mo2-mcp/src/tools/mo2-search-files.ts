/**
 * mo2_search_files — T1 glob/regex file search across enabled mods.
 *
 * Bounded by max_results. Pattern: glob like "**\/*.esp" or regex with
 * "regex:" prefix. Walks each enabled mod's directory; returns relative
 * paths prefixed by mod name.
 *
 * Paging (L9 fix, 2026-09-14): `max_results` still bounds the directory walk
 * itself (unchanged — a safety valve against pathological packs). `limit`/
 * `offset` additionally page the *response* over whatever the walk collected
 * (default limit 100), so a walk that found 3,000 matches doesn't serialize
 * all 3,000 in one call. `truncated` is true if EITHER the walk was cut off
 * by max_results OR more collected matches remain past this page; `nextOffset`
 * is set only when paging (not walk-cutoff) is what's left to fetch.
 * `compact=true` returns matches grouped by mod (`{ [modName]: path[] }`,
 * paths without the repeated "modName/" prefix) instead of the flat
 * mod-prefixed string array — a meaningful token saving when a search hits
 * many files under few mods. Default (compact omitted) keeps today's flat
 * `results: string[]` shape.
 */
import { z } from "zod";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { registerTool } from "../tool-registry.js";
import { readMoIni } from "../mo-ini.js";
import { readProfile } from "../profile-reader.js";
import { requireBoundContext, bindingSnapshot } from "../binding.js";
import { resolveProfileName } from "../path-helpers.js";

// BUG-10 fix (2026-06-17): pattern gains .min(1). Empty glob/regex would match
// nothing useful and falls through silently today; explicit invalid_arguments
// is the correct contract.
const inputSchema = z.object({
  profile: z.string().optional(),
  pattern: z.string().min(1),
  max_results: z.number().int().min(1).max(10000).default(1000),
  limit: z.number().int().positive().default(100),
  offset: z.number().int().nonnegative().default(0),
  compact: z.boolean().default(false),
});

function globToRegex(pattern: string): RegExp {
  // Escape regex metachars (but NOT *, ?, /).
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // Consume `**` together with an optional trailing `/` so the slash
  // collapses when `**` matches zero segments. This is the standard glob
  // semantic used by minimatch / picomatch / fast-glob: `**/*.esp` matches
  // both `dir/foo.esp` and root-level `foo.esp`.
  const transformed = escaped
    .replace(/\*\*\/?/g, "\x01")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\x01/g, "(?:.*/)?");
  return new RegExp(`^${transformed}$`, "i");
}

function _stripDataPrefixFromPattern(pattern: string): string {
  if (pattern.startsWith("regex:")) {
    const source = pattern.slice("regex:".length);
    const stripped = source.replace(/^(\^?)(?:\[(?:Dd|dD)\]ata|data)\//i, "$1");
    return "regex:" + stripped;
  }

  return pattern.replace(/^data\//i, "");
}

registerTool({
  name: "mo2_search_files",
  tier: "T1",
  description:
    "Glob/regex file search across enabled mod trees. Bounded by max_results (default 1000) for the walk, and by limit/offset (default limit 100) for the returned page. pattern='**/*.esp' for glob, 'regex:^foo' for regex. Returns mod-prefixed paths + truncated flag + nextOffset. compact=true groups results by mod instead of repeating the mod-name prefix per path.",
  inputSchema,
  handler: async (args, ctx) => {
    const bound = requireBoundContext(ctx);
    const profile = resolveProfileName(ctx, args.profile as string | undefined);
    const inputPattern = args.pattern as string;
    const pattern = _stripDataPrefixFromPattern(inputPattern);
    const maxResults = (args.max_results as number) ?? 1000;

    const ini = await readMoIni(join(bound.config.mo2Root, "ModOrganizer.ini"));
    const modsDir = ini.settings.modDirectory ?? join(bound.config.mo2Root, "mods");
    const p = await readProfile(join(bound.config.mo2Root, "profiles", profile));
    const enabled = p.mods.filter((m) => m.enabled && !m.isSeparator);

    const isRegex = pattern.startsWith("regex:");
    const matcher = isRegex ? new RegExp(pattern.slice(6), "i") : globToRegex(pattern);

    const hits: Array<{ mod: string; path: string }> = [];
    let walkTruncated = false;

    outer: for (const mod of enabled) {
      const root = join(modsDir, mod.name);
      const walk = async (dir: string): Promise<void> => {
        if (hits.length >= maxResults) {
          walkTruncated = true;
          return;
        }
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (hits.length >= maxResults) {
            walkTruncated = true;
            return;
          }
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            await walk(full);
          } else {
            const rel = full.slice(root.length + 1).replace(/\\/g, "/");
            if (matcher.test(rel)) hits.push({ mod: mod.name, path: rel });
          }
        }
      };
      await walk(root);
      if (walkTruncated) break outer;
    }

    // Paging (L9 fix): slice the collected hits server-side. `total` is the
    // number of hits the walk collected (itself capped by max_results, see
    // walkTruncated above) — NOT necessarily every file on disk that matches.
    const total = hits.length;
    // Defaults are also enforced here (not just in inputSchema) because
    // tests — and any caller that bypasses the MCP dispatch's zod
    // safeParse — invoke the handler with a raw args object (see the
    // pre-existing maxResults fallback above for the same pattern).
    const limit = (args.limit as number | undefined) ?? 100;
    const offset = (args.offset as number | undefined) ?? 0;
    const page = hits.slice(offset, offset + limit);
    const morePagesRemain = offset + page.length < total;
    const truncated = walkTruncated || morePagesRemain;
    const compact = (args.compact as boolean | undefined) ?? false;

    const results: string[] | Record<string, string[]> = compact
      ? page.reduce<Record<string, string[]>>((acc, h) => {
          (acc[h.mod] ??= []).push(h.path);
          return acc;
        }, {})
      : page.map((h) => `${h.mod}/${h.path}`);

    return {
      ok: true,
      result: {
        results,
        truncated,
        count: page.length,
        total,
        limit,
        offset,
        ...(morePagesRemain ? { nextOffset: offset + page.length } : {}),
        pattern: inputPattern,
        profile,
      },
      error: null,
    };
  },
});
