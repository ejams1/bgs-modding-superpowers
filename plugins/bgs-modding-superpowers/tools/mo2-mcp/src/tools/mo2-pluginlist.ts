/**
 * mo2_pluginlist — T1 native TS read of plugins.txt.
 *
 * `*` prefix = enabled (FO4/SSE convention, NOT charrdge's inverted polarity).
 * Optional enrich=true: when broker live, adds masters/load_order/origin/flags
 * via mobase IPluginList.
 *
 * Paging (L9 fix, 2026-09-14): `limit`/`offset` bound the returned page
 * server-side (default limit 100); `compact=true` trims each row to
 * name/enabled/gui_rank (+isComment on synthetic comment rows). gui_rank
 * (not the raw `priority` field, which is only populated when enrich=true
 * and MO2 is live) is used as the "index" because it's always populated —
 * see enrichGuiFields' offlineRank fallback below.
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

type CompactPluginRow = {
  name: string;
  enabled: boolean;
  gui_rank?: number;
  isComment?: boolean;
};

type PluginRow = Record<string, unknown> & {
  name: string;
  enabled: boolean;
  isComment?: boolean;
  priority?: number;
  gui_rank?: number;
  load_order_role?: "loads_first_lowest_precedence" | "loads_last_highest_precedence" | "intermediate";
};

function enrichGuiFields(plugins: PluginRow[]): PluginRow[] {
  const realPluginCount = plugins.filter((pl) => !pl.isComment).length;
  let offlineRank = 0;

  return plugins.map((pl) => {
    if (pl.isComment) return pl;

    offlineRank += 1;
    const guiRank = typeof pl.priority === "number" ? pl.priority + 1 : offlineRank;
    const loadOrderRole =
      guiRank === 1
        ? "loads_first_lowest_precedence"
        : guiRank === realPluginCount
          ? "loads_last_highest_precedence"
          : "intermediate";

    return {
      ...pl,
      gui_rank: guiRank,
      load_order_role: loadOrderRole,
    };
  });
}

registerTool({
  name: "mo2_pluginlist",
  tier: "T1",
  description:
    "Read plugins.txt. Returns plugins with name + enabled (* = enabled per MO2/FO4 convention). Optional broker enrich adds masters/load_order/origin/flags. Paged: limit (default 100) / offset bound the returned page; plugin_count is always the unpaged total, truncated/nextOffset signal more remain. compact=true trims each row to name/enabled/gui_rank.",
  inputSchema,
  handler: async (args, ctx) => {
    const bound = requireBoundContext(ctx);
    const profile = resolveProfileName(ctx, args.profile as string | undefined);
    const profileDir = join(bound.config.mo2Root, "profiles", profile);
    const p = await readProfile(profileDir);
    let plugins: PluginRow[] = p.plugins.map((pl) => ({ ...pl }));
    if (args.enrich && bound.pipeClient) {
      try {
        const resp = await bound.pipeClient.call("plugins.list", {});
        if (resp.ok && resp.result && typeof resp.result === "object") {
          const livePlugins = (resp.result as { plugins?: Array<{ name: string }> }).plugins ?? [];
          const liveMap = new Map<string, Record<string, unknown>>();
          for (const lp of livePlugins) liveMap.set(lp.name, lp);
          plugins = plugins.map((pl) => ({ ...pl, ...(liveMap.get(pl.name) ?? {}) }));
        }
      } catch {
        // Silent fail
      }
    }
    plugins = enrichGuiFields(plugins);
    const total = plugins.length;
    // Defaults are also enforced here (not just in inputSchema) because
    // tests — and any caller that bypasses the MCP dispatch's zod
    // safeParse — invoke the handler with a raw args object.
    const limit = (args.limit as number | undefined) ?? 100;
    const offset = (args.offset as number | undefined) ?? 0;
    const page = plugins.slice(offset, offset + limit);
    const truncated = offset + page.length < total;
    const compact = (args.compact as boolean | undefined) ?? false;
    const outPlugins: PluginRow[] | CompactPluginRow[] = compact
      ? page.map((pl) => ({
          name: pl.name,
          enabled: pl.enabled,
          ...(typeof pl.gui_rank === "number" ? { gui_rank: pl.gui_rank } : {}),
          ...(pl.isComment ? { isComment: true } : {}),
        }))
      : page;

    return {
      ok: true,
      result: {
        profile,
        plugins: outPlugins,
        plugin_count: total,
        limit,
        offset,
        truncated,
        ...(truncated ? { nextOffset: offset + page.length } : {}),
        _meta: {
          array_order: "plugins_txt_forward_order_matches_gui",
          array_order_note:
            "First entry is at TOP of MO2 GUI plugins panel (loaded first = lowest precedence). Last entry is at BOTTOM of GUI (loaded last = WINS all plugin conflicts).",
          priority_vs_load_order:
            "When enriched, 'priority' = position in plugins.txt; 'load_order' = effective post-sort load index (these differ when ESL/light/master plugins interleave). Agents reasoning about precedence should use 'load_order'.",
          enabled_marker:
            "Asterisk (*) prefix in plugins.txt means enabled. plugin_count includes the comment header entry as a synthetic isComment:true row.",
          paging_note:
            "plugins[] is a page of plugin_count total rows (comment rows included), windowed by limit/offset (default limit 100). truncated=true and nextOffset are set when more rows remain past this page.",
        },
      },
      error: null,
    };
  },
});
