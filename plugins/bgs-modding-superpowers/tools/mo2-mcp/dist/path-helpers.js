/**
 * Path helpers — derive common paths from ToolContext.
 *
 * Per PLAN-PATCH P-F1: extracted as shared so all S4/S5 tools reuse.
 */
import { join } from "node:path";
import { readMoIni } from "./mo-ini.js";
import { requireBoundContext } from "./binding.js";
export async function resolveModMetaPath(modName, ctx) {
    const bound = requireBoundContext(ctx);
    const ini = await readMoIni(join(bound.config.mo2Root, "ModOrganizer.ini"));
    const modsDir = ini.settings.modDirectory ?? join(bound.config.mo2Root, "mods");
    return join(modsDir, modName, "meta.ini");
}
export async function resolveModsDir(ctx) {
    const bound = requireBoundContext(ctx);
    const ini = await readMoIni(join(bound.config.mo2Root, "ModOrganizer.ini"));
    return ini.settings.modDirectory ?? join(bound.config.mo2Root, "mods");
}
/**
 * The session's effective profile.
 *
 * `bindNow` resolves the profile once and calls `promoteBoundProfile`, which
 * moves it to the front of `allowedProfiles`. So `allowedProfiles[0]` is the
 * bound profile, while the rest of the array remains the switch allowlist that
 * mo2_switch_profile enforces.
 *
 * Every tool taking an optional `profile` argument must route through this
 * rather than defaulting to the literal "Default". That literal is only the
 * fallback baked into the config schema for an instance with no `.mo2-mcp.json`;
 * on any instance whose profile is named something else — which is most real
 * modlists — it names a directory that does not exist, and the tool fails with
 * ENOENT on profiles/Default/modlist.txt.
 */
export function resolveProfileName(ctx, profile) {
    const explicit = profile?.trim();
    if (explicit)
        return explicit;
    const bound = requireBoundContext(ctx);
    return bound.config.allowedProfiles[0] ?? "Default";
}
export function resolveProfileDir(ctx, profile) {
    const bound = requireBoundContext(ctx);
    return join(bound.config.mo2Root, "profiles", resolveProfileName(ctx, profile));
}
