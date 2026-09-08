import type { ToolContext } from "../types.js";
import { resolveProfileDir, resolveProfileName } from "../path-helpers.js";
import { requireBoundContext, bindingSnapshot } from "../binding.js";

/**
 * Sidecar World cache invalidation after mod-mutation operations.
 *
 * Previously this module also exposed `refreshOrganizer` / `refreshOrganizerAndInvalidateWorld`
 * which invoked broker `organizer.refresh`.  That call was reverted because it caused
 * MO2 to attempt mod-list rewrites against a transiently inconsistent in-memory model
 * (user observed "failed to write mod list: invalid mod index: N" dialogs and modlist
 * corruption).  MO2's own internal save/refresh cycle is sufficient; we only need to
 * tell the sidecar to drop its World cache so subsequent assets reads pick up the
 * post-mutation filesystem state.
 */
export async function invalidateWorld(
  ctx: ToolContext,
  profiles?: string[],
): Promise<void> {
  const sidecar = requireBoundContext(ctx).sidecar;
  if (!sidecar) return;
  // No explicit profiles means "whatever this session is bound to". Callers
  // that computed a list of touched profiles pass it through; an empty list
  // means the mutation touched none by name, which still has to invalidate the
  // bound profile's World cache.
  const targets = profiles?.length ? profiles : [resolveProfileName(ctx)];
  for (const profile of Array.from(new Set(targets))) {
    await sidecar.call("world.invalidate", { profile_dir: resolveProfileDir(ctx, profile) });
  }
}
