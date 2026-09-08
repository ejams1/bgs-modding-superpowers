import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getTool, _clearToolsForTests } from "../../src/tool-registry.js";
import { AuditLogger } from "../../src/audit.js";
import { PlanCache } from "../../src/plan-apply.js";
import { SnapshotManager } from "../../src/snapshot.js";
import { BindingManager } from "../../src/binding.js";
import { resolveProfileName, resolveProfileDir } from "../../src/path-helpers.js";
import type { ToolContext } from "../../src/types.js";

/**
 * Regression suite for the hardcoded "Default" profile.
 *
 * Every profile-taking tool declared `profile: z.string().default("Default")`
 * and fell back to that same literal in its handler. On an instance whose
 * profile is named anything else — which is most real modlists, e.g. a
 * Wabbajack list with a single "Life in the Ruins" profile — omitting the
 * argument produced ENOENT on profiles/Default/modlist.txt. The session binding
 * already knew the right answer and was simply not consulted.
 *
 * The failure was safe (it never wrote to the wrong profile) but it made the
 * whole server unusable without passing `profile` on every single call.
 */

const PROFILE = "Life in the Ruins";

function stubSidecar() {
  return { start: async () => undefined, stop: async () => undefined, isReady: () => false } as never;
}

function stubPipe() {
  return {
    discoverAndConnect: async () => undefined,
    isConnected: () => false,
    close: () => undefined,
  } as never;
}

async function bindTo(profileOnDisk: string, selectedProfile?: string): Promise<{ root: string; ctx: ToolContext }> {
  const root = await createTrackedTempDir("mo2-profile-default-");
  await mkdir(join(root, "profiles", profileOnDisk), { recursive: true });
  await writeFile(
    join(root, "profiles", profileOnDisk, "modlist.txt"),
    "+WinningMod\n+LosingMod\n-DisabledMod\n",
    "utf8",
  );
  await writeFile(join(root, "profiles", profileOnDisk, "plugins.txt"), "*Fallout4.esm\n", "utf8");
  const selectedLine = selectedProfile ? `selected_profile=@ByteArray(${selectedProfile})\n` : "";
  await writeFile(
    join(root, "ModOrganizer.ini"),
    `[General]\ngame=fallout4\ngameName=Fallout 4\n${selectedLine}[Settings]\nbase_directory=${root}\n`,
    "utf8",
  );

  const binding = new BindingManager({
    createSidecarClient: stubSidecar,
    createPipeClient: stubPipe,
    detectMo2Running: async () => ({
      processRunning: false,
      sharedMemoryPresent: "unknown" as const,
      profileLockHeld: false,
      pid: null,
      online: false,
    }),
    log: () => undefined,
  });
  const snapshot = await binding.bind({ mo2Root: root });
  if (snapshot.state !== "bound") throw new Error(`bind failed: ${JSON.stringify(snapshot)}`);

  return {
    root,
    ctx: {
      binding,
      sessionId: "test",
      plans: new PlanCache(),
      snapshots: new SnapshotManager(join(root, ".mo2-mcp", "snapshots"), "test"),
      audit: new AuditLogger(join(root, ".mo2-mcp", "audit"), "test"),
    } as unknown as ToolContext,
  };
}

describe("profile resolution without an explicit profile argument", () => {
  const previousEnvProfile = process.env.BGS_MO2_PROFILE;

  beforeAll(async () => {
    _clearToolsForTests();
    await import("../../src/tools/mo2-modlist.js");
  });

  beforeEach(() => {
    delete process.env.BGS_MO2_PROFILE;
  });

  afterEach(() => {
    if (previousEnvProfile === undefined) delete process.env.BGS_MO2_PROFILE;
    else process.env.BGS_MO2_PROFILE = previousEnvProfile;
  });

  it("mo2_modlist reads the bound profile when none is passed", async () => {
    // The original bug: this call resolved to "Default" and failed with
    // ENOENT on profiles/Default/modlist.txt.
    const { ctx } = await bindTo(PROFILE, PROFILE);

    const result = (await getTool("mo2_modlist")!.handler({}, ctx)) as {
      ok: boolean;
      result?: { mods: Array<{ name: string; enabled: boolean }> };
      error?: { code: string; message: string };
    };

    expect(result.error ?? null).toBeNull();
    expect(result.ok).toBe(true);
    // modlist.txt is stored in reverse priority order (first line wins), so the
    // tool returns ascending priority. What matters here is that it read the
    // bound profile's file at all rather than ENOENT-ing on profiles/Default.
    expect([...(result.result?.mods ?? [])].map((mod) => mod.name).sort()).toEqual([
      "DisabledMod",
      "LosingMod",
      "WinningMod",
    ]);
    expect(result.result?.mods.find((mod) => mod.name === "DisabledMod")?.enabled).toBe(false);
  });

  it("an explicit profile argument still wins over the binding", async () => {
    const { root, ctx } = await bindTo(PROFILE, PROFILE);
    await mkdir(join(root, "profiles", "Other"), { recursive: true });
    await writeFile(join(root, "profiles", "Other", "modlist.txt"), "+OtherMod\n", "utf8");
    await writeFile(join(root, "profiles", "Other", "plugins.txt"), "", "utf8");

    const result = (await getTool("mo2_modlist")!.handler({ profile: "Other" }, ctx)) as {
      ok: boolean;
      result?: { mods: Array<{ name: string }> };
    };

    expect(result.ok).toBe(true);
    expect(result.result?.mods.map((mod) => mod.name)).toEqual(["OtherMod"]);
  });

  it("resolveProfileName returns the bound profile and resolveProfileDir agrees", async () => {
    const { root, ctx } = await bindTo(PROFILE, PROFILE);

    expect(resolveProfileName(ctx)).toBe(PROFILE);
    expect(resolveProfileDir(ctx)).toBe(join(root, "profiles", PROFILE));
  });

  it("resolveProfileName ignores a blank profile argument", async () => {
    // A caller passing "" or "   " must not resolve to an empty profile path.
    const { ctx } = await bindTo(PROFILE, PROFILE);

    expect(resolveProfileName(ctx, "   ")).toBe(PROFILE);
    expect(resolveProfileName(ctx, "")).toBe(PROFILE);
  });
});
