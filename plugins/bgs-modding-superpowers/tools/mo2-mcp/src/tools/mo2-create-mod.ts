/**
 * mo2_create_mod — T3 create an empty mod via live MO2 broker.
 *
 * This is live-only by design: empty mod creation must go through
 * IOrganizer.createMod/modList priority wiring rather than offline emulation.
 */
import { z } from "zod";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { registerTool } from "../tool-registry.js";
import { routeToPlanApply, type PlanApplyHandler } from "../plan-apply.js";
import { readProfile } from "../profile-reader.js";
import { resolveModsDir, resolveProfileDir, resolveProfileName } from "../path-helpers.js";
import { assertActiveProfile } from "../profile-guard.js";
import { invalidateWorld } from "./state-sync.js";
import { requireBoundContext } from "../binding.js";
import { logApplyEvent } from "../log-apply.js";
import { BrokerEnrichedError } from "../broker-error.js";

const inputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("plan"),
    name: z.string().min(1),
    wins_over: z.string().min(1).optional(),
    // If <modsDir>/<name> already exists on disk but MO2 has not registered
    // it, register it as-is instead of creating a new empty mod. Without this
    // the broker refuses (rather than letting IOrganizer.createMod open MO2's
    // modal "Mod Exists" dialog, which blocks the pipe until a human clicks).
    adopt_existing: z.boolean().optional(),
    profile: z.string().optional(),
  }).strict(),
  z.object({ mode: z.literal("apply"), plan_id: z.string().min(1), lease_token: z.string().min(1) }).strict(),
]);

const RESPONSE_META = {
  priority_convention: "mobase_full_space_higher_wins",
  modlist_file_order: "reverse_of_gui",
  gui_direction_hint: "priority_0_at_gui_top_loses; priority_(N-1)_at_gui_bottom_wins",
};

async function _targetPriority(
  mo2Root: string,
  profile: string,
  winsOver: string | undefined,
): Promise<number | undefined> {
  if (winsOver === undefined) return undefined;
  const p = await readProfile(join(mo2Root, "profiles", profile));
  const winsOverPri = p.mods.find((mod) => mod.name === winsOver)?.priority;
  if (winsOverPri == null) throw new Error(`wins_over_mod_not_found: ${winsOver}`);
  return winsOverPri + 1;
}

const handler: PlanApplyHandler = {
  toolName: "mo2_create_mod",
  async buildPlan(args, ctx) {
    const bound = requireBoundContext(ctx);
    if (!bound.pipeClient) throw new Error("live_mo2_required_for_create_mod");
    const profile = resolveProfileName(ctx, args.profile as string | undefined);
    // Freeze the resolved profile into the stored plan. apply re-resolves from
    // the same args, so without this a session rebound to another profile
    // between plan and apply would apply the diff to a different profile than
    // the one it was computed against.
    args.profile = profile;
    // BUG-9 fix (2026-06-17): refuse plan generation when the requested
    // profile is not the live MO2's active profile. The applyMutation path
    // already enforces this; pushing it up to buildPlan prevents misleading
    // plan envelopes that look mintable but would never apply.
    await assertActiveProfile(ctx, profile);
    const winsOver = args.wins_over as string | undefined;
    const targetPri = await _targetPriority(bound.config.mo2Root, profile, winsOver);
    const modlistPath = join(resolveProfileDir(ctx, profile), "modlist.txt");
    const modsDir = await resolveModsDir(ctx);
    const targetPath = join(modsDir, args.name as string);
    // U4: mirror the broker's existence guard at plan time so a doomed plan
    // (one that is certain to be refused at apply, or worse, would have hit
    // createMod's blocking "Mod Exists" modal before the mods.create fix)
    // is never minted in the first place.
    const dirExists = existsSync(targetPath);
    if (dirExists && args.adopt_existing !== true) {
      throw new BrokerEnrichedError({
        code: "mod_dir_exists_unregistered",
        message: `mod_dir_exists_unregistered: ${targetPath} already exists on disk but is not registered by MO2 (creating it would trigger the blocking "Mod Exists" dialog). Pass adopt_existing=true to register it as-is.`,
        details: { existing_dir: targetPath, name: args.name },
      });
    }
    const adopting = dirExists && args.adopt_existing === true;
    const winsOverText = winsOver !== undefined
      ? ` (wins_over ${winsOver}, pri=${String(targetPri)})`
      : "";
    const adoptText = args.adopt_existing === true ? " (adopt_existing: register the folder if it already exists on disk)" : "";
    const diff = adopting
      ? `Adopt existing folder ${String(args.name)}${winsOverText}`
      : `Create empty mod ${String(args.name)}${winsOverText}${adoptText}`;
    return {
      diff,
      // U14: cover the mod dir itself, not just modlist.txt, so mo2_rollback
      // can undo the registration (and, for adopt, the meta.ini refresh
      // writes) rather than leaving them behind.
      affectedFiles: [modlistPath, targetPath],
      targets: [{ path: modlistPath, kind: "text-file" }],
    };
  },
  async applyMutation(plan, ctx) {
    const bound = requireBoundContext(ctx);
    if (!bound.pipeClient) throw new Error("live_mo2_required_for_create_mod");
    const profile = resolveProfileName(ctx, plan.args.profile as string | undefined);
    await assertActiveProfile(ctx, profile);
    const winsOver = plan.args.wins_over as string | undefined;
    const targetPri = await _targetPriority(bound.config.mo2Root, profile, winsOver);
    const payload: { name: string; priority?: number; adopt_existing?: boolean } = { name: plan.args.name as string };
    if (targetPri !== undefined) payload.priority = targetPri;
    if (plan.args.adopt_existing === true) payload.adopt_existing = true;

    const resp = await bound.pipeClient.call("mods.create", payload);
    if (!resp.ok) {
      // U12 (TS half): carry the broker's error code + details through
      // instead of collapsing every refusal to a generic Error, so callers
      // (and dispatch's envelope) can branch on e.g. mod_dir_exists_unregistered
      // instead of string-matching the message.
      const details = resp.error?.details && typeof resp.error.details === "object"
        ? { ...(resp.error.details as Record<string, unknown>) }
        : {};
      throw new BrokerEnrichedError({
        code: resp.error?.code ?? "broker_error",
        message: resp.error?.message ?? "broker error",
        details,
      });
    }
    const result = (resp.result ?? {}) as Record<string, unknown>;
    // U2: adopt_existing is silently dropped by a broker deployed before this
    // parameter existed (unknown payload keys are ignored), which would send
    // this request straight into the modal-hang this flag exists to avoid.
    // Detect that by requiring the response to actually claim adopted or
    // created; a broker that understood the request always sets one.
    if (plan.args.adopt_existing === true && result.adopted !== true && result.created !== true) {
      throw new BrokerEnrichedError({
        code: "stale_broker_dropped_adopt_existing",
        message: `mods.create for "${plan.args.name as string}" returned neither adopted nor created after requesting adopt_existing=true. The deployed control-plane broker may predate adopt_existing support and silently ignored it, which risks MO2's blocking "Mod Exists" dialog. Redeploy the control plane (scripts/install-mo2-control-plane.ps1) and retry.`,
        details: { name: plan.args.name, result },
      });
    }
    // Defensive: ensure mod folder exists on disk. broker mods.create may leave
    // the folder unmaterialized until MO2's next save cycle; downstream tools
    // (mo2_remove_mod buildPlan, etc.) check existsSync on the mod path and
    // would otherwise throw mod_not_found. Use the broker-returned
    // absolute_path when present; fall back to <modsDir>/<name>.
    const modsDir = await resolveModsDir(ctx);
    const absPath = typeof result.absolute_path === "string"
      ? (result.absolute_path as string)
      : join(modsDir, plan.args.name as string);
    await mkdir(absPath, { recursive: true });
    await invalidateWorld(ctx, [profile]);
    // U9: an adopt apply is not a creation -- report which one actually
    // happened, and the priority the broker confirmed rather than the one
    // we merely requested.
    const adopted = result.adopted === true;
    const reportedPriority = result.priority ?? targetPri ?? "none";
    await logApplyEvent(
      handler.toolName,
      `${adopted ? "adopted" : "created"} "${plan.args.name as string}" wins_over="${winsOver ?? "none"}" → priority ${reportedPriority}`,
      bound,
      plan.planId,
      profile,
    );
    return { ...result, _meta: RESPONSE_META };
  },
};

registerTool({
  name: "mo2_create_mod",
  tier: "T3",
  description:
    "Create empty mod via broker mods.create. Optional 'wins_over' positions it just above a named mod in precedence (= just below visually in MO2 GUI). If the mod folder already exists on disk but is unregistered, this refuses at plan time unless 'adopt_existing' is true, in which case it registers the folder as-is (never triggers MO2's modal 'Mod Exists' prompt) and the result includes an 'inventory' (file_count, total_bytes, plugin_names) of whatever the stale folder actually contained -- adopt does not produce an empty mod.",
  inputSchema,
  handler: (args, ctx) =>
    routeToPlanApply(handler, args, ctx, ctx.plans, ctx.snapshots) as Promise<unknown>,
});
