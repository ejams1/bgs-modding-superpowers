import type { ToolContext } from "./types.js";
export declare function resolveModMetaPath(modName: string, ctx: ToolContext): Promise<string>;
export declare function resolveModsDir(ctx: ToolContext): Promise<string>;
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
export declare function resolveProfileName(ctx: ToolContext, profile?: string): string;
export declare function resolveProfileDir(ctx: ToolContext, profile?: string): string;
