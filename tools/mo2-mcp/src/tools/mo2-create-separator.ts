/**
 * mo2_create_separator — T3 create an MO2 separator mod.
 *
 * MO2 flags separators by conventional `<name>_separator` mod names. Color has
 * no public mobase setter, so the MCP writes meta.ini directly and refreshes.
 */
import { z } from "zod";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { registerTool } from "../tool-registry.js";
import { routeToPlanApply, type PlanApplyHandler } from "../plan-apply.js";
import { readProfile } from "../profile-reader.js";
import { resolveModsDir, resolveProfileDir, resolveProfileName } from "../path-helpers.js";
import { atomicWriteText } from "../atomic.js";
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
    color: z.string().optional(),
    // See mo2_create_mod's adopt_existing: without this, a stale unregistered
    // <name>_separator folder left by an aborted apply or hand copy is
    // refused by the broker with no way to satisfy its own advice (U10).
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

function _separatorName(name: unknown): string {
  return `${String(name)}_separator`;
}

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
  toolName: "mo2_create_separator",
  async buildPlan(args, ctx) {
    const bound = requireBoundContext(ctx);
    if (!bound.pipeClient) throw new Error("live_mo2_required");
    const profile = resolveProfileName(ctx, args.profile as string | undefined);
    // Freeze the resolved profile into the stored plan. apply re-resolves from
    // the same args, so without this a session rebound to another profile
    // between plan and apply would apply the diff to a different profile than
    // the one it was computed against.
    args.profile = profile;
    // BUG-9 fix (2026-06-17): refuse plan generation when the requested
    // profile is not the live MO2's active profile; mirrors the
    // applyMutation guard.
    await assertActiveProfile(ctx, profile);
    const winsOver = args.wins_over as string | undefined;
    const targetPri = await _targetPriority(bound.config.mo2Root, profile, winsOver);
    const sepName = _separatorName(args.name);
    const modlistPath = join(resolveProfileDir(ctx, profile), "modlist.txt");
    const modsDir = await resolveModsDir(ctx);
    const targetPath = join(modsDir, sepName);
    // U10/U4 parity: mirror the broker's existence guard at plan time.
    const dirExists = existsSync(targetPath);
    if (dirExists && args.adopt_existing !== true) {
      throw new BrokerEnrichedError({
        code: "mod_dir_exists_unregistered",
        message: `mod_dir_exists_unregistered: ${targetPath} already exists on disk but is not registered by MO2 (creating it would trigger the blocking "Mod Exists" dialog). Pass adopt_existing=true to register it as-is.`,
        details: { existing_dir: targetPath, name: sepName },
      });
    }
    const adopting = dirExists && args.adopt_existing === true;
    const winsOverText = winsOver === undefined ? "" : ` (wins_over ${winsOver}, pri=${targetPri})`;
    const colorText = typeof args.color === "string" ? ` color=${args.color}` : "";
    const diff = adopting
      ? `Adopt existing folder as separator "${String(args.name)}" → ${sepName}${winsOverText}${colorText}`
      : `Create separator "${String(args.name)}" → ${sepName}${winsOverText}${colorText}`;
    return {
      diff,
      // U14 parity: cover the separator's mod dir so mo2_rollback can undo
      // the registration, not just the modlist.txt line.
      affectedFiles: [modlistPath, targetPath],
      targets: [{ path: modlistPath, kind: "text-file" }],
    };
  },
  async applyMutation(plan, ctx) {
    const bound = requireBoundContext(ctx);
    if (!bound.pipeClient) throw new Error("live_mo2_required");
    const profile = resolveProfileName(ctx, plan.args.profile as string | undefined);
    await assertActiveProfile(ctx, profile);
    const sepName = _separatorName(plan.args.name);
    const winsOver = plan.args.wins_over as string | undefined;
    const targetPri = await _targetPriority(bound.config.mo2Root, profile, winsOver);
    const payload: { name: string; priority?: number; adopt_existing?: boolean } = { name: sepName };
    if (targetPri !== undefined) payload.priority = targetPri;
    if (plan.args.adopt_existing === true) payload.adopt_existing = true;

    const resp = await bound.pipeClient.call("mods.create", payload);
    if (!resp.ok) {
      // U12 (TS half), same as mo2_create_mod: preserve the broker's code +
      // details instead of a generic Error, so mod_dir_exists_unregistered
      // (and the adopt_existing hint it carries) is branchable.
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
    // U2 parity: a stale broker silently drops adopt_existing rather than
    // rejecting it, so verify the response actually claims adopted or created.
    if (plan.args.adopt_existing === true && result.adopted !== true && result.created !== true) {
      throw new BrokerEnrichedError({
        code: "stale_broker_dropped_adopt_existing",
        message: `mods.create for separator "${sepName}" returned neither adopted nor created after requesting adopt_existing=true. The deployed control-plane broker may predate adopt_existing support and silently ignored it, which risks MO2's blocking "Mod Exists" dialog. Redeploy the control plane (scripts/install-mo2-control-plane.ps1) and retry.`,
        details: { name: sepName, result },
      });
    }

    // Defensive: ensure separator folder exists on disk (see mo2_create_mod for rationale).
    const modsDir = await resolveModsDir(ctx);
    const absPath = typeof result.absolute_path === "string"
      ? (result.absolute_path as string)
      : join(modsDir, sepName);
    await mkdir(absPath, { recursive: true });

    if (typeof plan.args.color === "string") {
      await atomicWriteText(join(absPath, "meta.ini"), `[General]\ncolor=${plan.args.color}\n`);
    }

    await invalidateWorld(ctx, [profile]);
    // U9 parity: report adopted vs created and the broker-confirmed priority.
    const adopted = result.adopted === true;
    const reportedPriority = result.priority ?? targetPri ?? "none";
    await logApplyEvent(
      handler.toolName,
      `${adopted ? "adopted" : "created"} separator "${sepName}" wins_over="${winsOver ?? "none"}" → priority ${reportedPriority}`,
      bound,
      plan.planId,
      profile,
    );

    return { separator_name: sepName, color_set: typeof plan.args.color === "string", ...result, _meta: RESPONSE_META };
  },
};

registerTool({
  name: "mo2_create_separator",
  tier: "T3",
  description:
    "Create a separator (_separator suffix triggers FLAG_SEPARATOR). Optional 'wins_over' positions it just above a named mod in precedence (= just below visually in MO2 GUI). Optional color written to meta.ini.",
  inputSchema,
  handler: (args, ctx) =>
    routeToPlanApply(handler, args, ctx, ctx.plans, ctx.snapshots) as Promise<unknown>,
});
