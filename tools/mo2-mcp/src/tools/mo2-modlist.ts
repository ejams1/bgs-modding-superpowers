/**
 * mo2_modlist — T1 native TS read of modlist.txt.
 *
 * Returns mods with name + priority + enabled + is_separator (offline-fast).
 * Optional enrich=true: when broker pipe is live, adds live_priority from
 * mobase IModList for cross-check.
 *
 * Paging (L9 fix, 2026-09-14): `limit`/`offset` bound the returned page
 * server-side (default limit 100) so a 500-mod pack doesn't blow up every
 * call's token cost. `compact=true` trims each row to
 * name/priority/enabled/is_separator, dropping section/gui_rank/
 * wins_over_count/live_priority. Defaults (no limit/offset/compact passed)
 * intentionally change response size vs. the pre-L9 behavior (which returned
 * every mod unconditionally) — that's the point of the fix — but the field
 * *shape* for a returned row is unchanged, so existing callers of small
 * modlists (<=100 mods) see identical output.
 */
import { z } from "zod";
import { join } from "node:path";
import { registerTool } from "../tool-registry.js";
import { readProfile } from "../profile-reader.js";
import { requireBoundContext } from "../binding.js";
import { resolveProfileName } from "../path-helpers.js";

const inputSchema = z.object({
  profile: z.string().optional(),
  enrich: z.boolean().default(false),
  limit: z.number().int().positive().default(100),
  offset: z.number().int().nonnegative().default(0),
  compact: z.boolean().default(false),
});

type CompactModRow = {
  name: string;
  priority: number;
  enabled: boolean;
  is_separator: boolean;
};

type ModRow = {
  name: string;
  priority: number;
  enabled: boolean;
  is_separator: boolean;
  live_priority?: number | null;
  section?: string | null;
  gui_rank?: number;
  wins_over_count?: number;
};

function effectivePriority(mod: ModRow): number {
  return typeof mod.live_priority === "number" ? mod.live_priority : mod.priority;
}

function enrichGuiFields(mods: ModRow[]): ModRow[] {
  const separators = mods
    .filter((m) => m.is_separator)
    .map((m) => ({ name: m.name, priority: effectivePriority(m) }))
    .sort((a, b) => b.priority - a.priority);

  return mods
    .map((m) => {
      const priority = effectivePriority(m);
      const section = m.is_separator ? null : (separators.find((s) => s.priority < priority)?.name ?? null);
      return {
        ...m,
        section,
        gui_rank: priority + 1,
        wins_over_count: priority,
      };
    })
    .sort((a, b) => effectivePriority(a) - effectivePriority(b));
}

registerTool({
  name: "mo2_modlist",
  tier: "T1",
  description:
    "Read modlist.txt. Returns mods with name/priority/enabled/is_separator. Native TS read (offline-fast). If enrich=true and MO2 is live, adds live_priority via broker. Paged: limit (default 100) / offset bound the returned page; mod_count is always the unpaged total, truncated/nextOffset signal more remain. compact=true trims each row to name/priority/enabled/is_separator.",
  inputSchema,
  handler: async (args, ctx) => {
    const bound = requireBoundContext(ctx);
    const profile = resolveProfileName(ctx, args.profile as string | undefined);
    const profileDir = join(bound.config.mo2Root, "profiles", profile);
    const p = await readProfile(profileDir);
    let mods: ModRow[] = p.mods.map((m) => ({
      name: m.name,
      priority: m.priority,
      enabled: m.enabled,
      is_separator: m.isSeparator,
    }));
    if (args.enrich && bound.pipeClient) {
      try {
        const resp = await bound.pipeClient.call("mods.list", {});
        if (resp.ok && resp.result && typeof resp.result === "object") {
          const liveMods = (resp.result as { mods?: Array<{ name: string; priority: number }> }).mods ?? [];
          const liveMap = new Map(liveMods.map((m) => [m.name, m]));
          mods = mods.map((m) => ({
            ...m,
            live_priority: liveMap.get(m.name)?.priority ?? null,
          }));
        }
      } catch {
        // Pipe failure → skip enrich silently
      }
    }
    // enrichGuiFields needs the FULL list to compute sections/gui_rank
    // correctly — page only after enrichment.
    const guiMods = enrichGuiFields(mods);
    const total = guiMods.length;
    // Defaults are also enforced here (not just in inputSchema) because
    // tests — and any caller that bypasses the MCP dispatch's zod
    // safeParse — invoke the handler with a raw args object.
    const limit = (args.limit as number | undefined) ?? 100;
    const offset = (args.offset as number | undefined) ?? 0;
    const page = guiMods.slice(offset, offset + limit);
    const truncated = offset + page.length < total;
    const compact = (args.compact as boolean | undefined) ?? false;
    const outMods: ModRow[] | CompactModRow[] = compact
      ? page.map((m) => ({ name: m.name, priority: m.priority, enabled: m.enabled, is_separator: m.is_separator }))
      : page;

    return {
      ok: true,
      result: {
        profile,
        mods: outMods,
        mod_count: total,
        limit,
        offset,
        truncated,
        ...(truncated ? { nextOffset: offset + page.length } : {}),
        _meta: {
          array_order: "gui_top_first",
          array_order_note:
            "First entry is at TOP of MO2 GUI mods panel (lowest priority = loses all conflicts). Last entry is at BOTTOM of GUI (highest priority = wins all conflicts).",
          priority_convention: "mobase_full_space_higher_wins",
          section_rule:
            "A separator at priority X labels mods at priorities X+1..(next_higher_separator.priority - 1). Each mod's 'section' field is the name of the separator that labels it (null if no separator below it in priority).",
          paging_note:
            "mods[] is a page of mod_count total mods, windowed by limit/offset (default limit 100). truncated=true and nextOffset are set when more mods remain past this page.",
        },
      },
      error: null,
    };
  },
});
