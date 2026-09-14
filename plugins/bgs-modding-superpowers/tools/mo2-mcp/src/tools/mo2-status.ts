/**
 * mo2_status — T1 read tool.
 *
 * Reports MO2 instance state: paths, game, profile, 7-signal detection result,
 * counts, MCP permission ceiling, sidecar + broker connection state.
 */
import { z } from "zod";
import { join } from "node:path";
import { registerTool } from "../tool-registry.js";
import { detectMo2Running } from "../detection.js";
import { readProfile } from "../profile-reader.js";
import { readMoIni, type MoIni } from "../mo-ini.js";
import type { ToolContext } from "../types.js";
import { requireBoundContext, bindingSnapshot } from "../binding.js";
import { resolveProfileName } from "../path-helpers.js";

const inputSchema = z.object({ profile: z.string().optional() });

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * mo2_status used to run its own resolution chain, consulting
 * $BGS_MO2_PROFILE and ModOrganizer.ini directly and ranking the env var above
 * the session binding. That had two consequences: status could report a
 * different profile than the one every other tool actually operated on, and
 * reading process.env at call time made the tool non-hermetic — an env var set
 * in the developer's shell changed the result under test.
 *
 * Both inputs are now folded into the binding itself (see bindNow), so the
 * shared helper is the single source of truth and an explicit
 * mo2_session({profile}) is no longer overridden by a stale env var.
 */
function resolveActiveProfile(
  args: Record<string, unknown>,
  ctx: ToolContext,
  _ini: MoIni,
): string | null {
  return nonEmpty(resolveProfileName(ctx, nonEmpty(args.profile))) ?? null;
}

registerTool({
  name: "mo2_status",
  tier: "T1",
  description:
    "Report MO2 instance state: paths, game, active profile, MO2-running detection (3-tier ladder), mod/plugin counts, MCP permission ceiling, broker+sidecar connectivity.",
  inputSchema,
  handler: async (args, ctx) => {
    if (bindingSnapshot(ctx).state !== "bound") {
      return {
        ok: true,
        bound: false,
        snapshot: bindingSnapshot(ctx),
        hint: "call mo2_session({ mo2Root }) to bind",
      };
    }
    const bound = requireBoundContext(ctx);
    const ini = await readMoIni(join(bound.config.mo2Root, "ModOrganizer.ini"));
    const profileName = resolveActiveProfile(args, ctx, ini);
    if (!profileName) {
      return {
        ok: false,
        result: null,
        error: {
          code: "no_profile_available",
          message:
            "No profile resolved. The binding resolves args.profile, then $BGS_MO2_PROFILE, then ModOrganizer.ini selected_profile, then allowed_profiles[0].",
        },
      };
    }
    const profileDir = join(bound.config.mo2Root, "profiles", profileName);
    const detection = await detectMo2Running({
      mo2Root: bound.config.mo2Root,
      profileDir,
    });
    let profile: Awaited<ReturnType<typeof readProfile>>;
    try {
      profile = await readProfile(profileDir);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        result: null,
        error: { code: "profile_not_found", message: `${profileName}: ${message}` },
      };
    }
    return {
      ok: true,
      result: {
        mo2_root: bound.config.mo2Root,
        game: ini.general.game,
        game_name: ini.general.gameName,
        game_path: ini.general.gamePath,
        profile: profile.name ?? profileName,
        permission_ceiling: bound.config.permissionCeiling,
        deny_patterns: bound.config.deny.length,
        detection: {
          process_running: detection.processRunning,
          shared_memory_present: detection.sharedMemoryPresent,
          profile_lock_held: detection.profileLockHeld,
          mo2_pid: detection.pid,
          online: detection.online,
        },
        counts: {
          mods_total: profile.mods.length,
          mods_enabled: profile.mods.filter((m) => m.enabled).length,
          plugins_total: profile.plugins.length,
          plugins_enabled: profile.plugins.filter((p) => p.enabled).length,
        },
        broker_connected: !!bound.pipeClient,
        sidecar_ready: !!bound.sidecar,
      },
      error: null,
    };
  },
});
