import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getTool, _clearToolsForTests } from "../../src/tool-registry.js";
import { AuditLogger } from "../../src/audit.js";
import { PlanCache } from "../../src/plan-apply.js";
import { SnapshotManager } from "../../src/snapshot.js";
import { BindingManager } from "../../src/binding.js";
import type { ToolContext } from "../../src/types.js";

/**
 * Profile resolution used to live inside mo2_status, which consulted
 * $BGS_MO2_PROFILE and ModOrganizer.ini itself. Every other profile-taking tool
 * defaulted to the literal "Default" instead, so status could report one profile
 * while the rest of the server operated on another — and on an instance whose
 * profile is not named "Default" those tools failed outright with ENOENT.
 *
 * Resolution now happens once, in BindingManager.bindNow, and every tool reads
 * the result via resolveProfileName. These tests therefore drive the real bind
 * path rather than hand-building a ToolContext, so they assert the behaviour the
 * whole server shares. Coverage is unchanged, including the BUG-23 @ByteArray
 * regression — which now protects every tool rather than status alone.
 */

function stubSidecar() {
  return {
    start: async () => undefined,
    stop: async () => undefined,
    isReady: () => false,
  } as never;
}

function stubPipe() {
  return {
    discoverAndConnect: async () => undefined,
    isConnected: () => false,
    close: () => undefined,
  } as never;
}

async function setupRoot(opts: {
  profiles?: string[];
  selectedProfile?: string;
  allowedProfiles?: string[];
} = {}): Promise<{ root: string; bind: (profile?: string) => Promise<ToolContext> }> {
  const root = await createTrackedTempDir("mo2-status-profile-");
  for (const profile of opts.profiles ?? []) {
    await mkdir(join(root, "profiles", profile), { recursive: true });
    await writeFile(join(root, "profiles", profile, "modlist.txt"), "+ModA\n-ModB\n", "utf8");
    await writeFile(join(root, "profiles", profile, "plugins.txt"), "*Fallout4.esm\n", "utf8");
  }
  const selectedLine = opts.selectedProfile
    ? `selected_profile=@ByteArray(${opts.selectedProfile})\n`
    : "";
  await writeFile(
    join(root, "ModOrganizer.ini"),
    `[General]\ngame=fallout4\ngameName=Fallout 4\n${selectedLine}[Settings]\nbase_directory=${root}\n`,
    "utf8",
  );

  if (opts.allowedProfiles) {
    await writeFile(
      join(root, ".mo2-mcp.json"),
      JSON.stringify({ allowed_profiles: opts.allowedProfiles }),
      "utf8",
    );
  }

  return {
    root,
    bind: async (profile?: string): Promise<ToolContext> => {
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
      const snapshot = await binding.bind({ mo2Root: root, profile });
      if (snapshot.state !== "bound") {
        throw new Error(`bind failed: ${JSON.stringify(snapshot)}`);
      }
      return {
        binding,
        sessionId: "test",
        plans: new PlanCache(),
        snapshots: new SnapshotManager(join(root, ".mo2-mcp", "snapshots"), "test"),
        audit: new AuditLogger(join(root, ".mo2-mcp", "audit"), "test"),
      } as unknown as ToolContext;
    },
  };
}

async function status(args: Record<string, unknown>, ctx: ToolContext) {
  return await getTool("mo2_status")!.handler(args, ctx) as {
    ok: boolean;
    result?: { profile: string; counts: { mods_total: number } | null };
    error?: { code: string; message: string };
  };
}

describe("mo2_status profile resolution", () => {
  const previousEnvProfile = process.env.BGS_MO2_PROFILE;

  beforeAll(async () => {
    _clearToolsForTests();
    await import("../../src/tools/mo2-status.js");
  });

  beforeEach(() => {
    delete process.env.BGS_MO2_PROFILE;
  });

  afterEach(() => {
    if (previousEnvProfile === undefined) delete process.env.BGS_MO2_PROFILE;
    else process.env.BGS_MO2_PROFILE = previousEnvProfile;
  });

  it("uses args.profile before env, ini, and config fallbacks", async () => {
    process.env.BGS_MO2_PROFILE = "EnvProfile";
    const { bind } = await setupRoot({
      profiles: ["ArgProfile", "EnvProfile", "IniProfile", "ConfigProfile"],
      selectedProfile: "IniProfile",
      allowedProfiles: ["ConfigProfile"],
    });

    const response = await status({ profile: "ArgProfile" }, await bind());

    expect(response.ok).toBe(true);
    expect(response.result?.profile).toBe("ArgProfile");
    expect(response.result?.counts?.mods_total).toBe(2);
  });

  it("uses an explicitly bound profile before env, ini, and config fallbacks", async () => {
    process.env.BGS_MO2_PROFILE = "EnvProfile";
    const { bind } = await setupRoot({
      profiles: ["BoundProfile", "EnvProfile", "IniProfile", "ConfigProfile"],
      selectedProfile: "IniProfile",
      allowedProfiles: ["ConfigProfile"],
    });

    const response = await status({}, await bind("BoundProfile"));

    expect(response.ok).toBe(true);
    expect(response.result?.profile).toBe("BoundProfile");
  });

  it("uses BGS_MO2_PROFILE when no profile is bound explicitly", async () => {
    process.env.BGS_MO2_PROFILE = "EnvProfile";
    const { bind } = await setupRoot({
      profiles: ["EnvProfile", "IniProfile", "ConfigProfile"],
      selectedProfile: "IniProfile",
      allowedProfiles: ["ConfigProfile"],
    });

    const response = await status({}, await bind());

    expect(response.ok).toBe(true);
    expect(response.result?.profile).toBe("EnvProfile");
  });

  it("uses ModOrganizer.ini selected_profile when env is absent", async () => {
    const { bind } = await setupRoot({
      profiles: ["IniProfile", "ConfigProfile"],
      selectedProfile: "IniProfile",
      allowedProfiles: ["ConfigProfile"],
    });

    const response = await status({}, await bind());

    expect(response.ok).toBe(true);
    expect(response.result?.profile).toBe("IniProfile");
  });

  it("uses config.allowedProfiles[0] when args, env, and ini are absent", async () => {
    const { bind } = await setupRoot({
      profiles: ["ConfigProfile"],
      allowedProfiles: ["ConfigProfile"],
    });

    const response = await status({}, await bind());

    expect(response.ok).toBe(true);
    expect(response.result?.profile).toBe("ConfigProfile");
  });

  it("falls back to Default and fails visibly when no source names a profile", async () => {
    // With nothing to resolve, the schema default is the last resort. The
    // failure must surface as a missing profile directory rather than silently
    // reading some other profile's state.
    const { bind } = await setupRoot();

    const response = await status({}, await bind());

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("profile_not_found");
  });

  // BUG-23 (issue #12) Bug 1 regression: real Starfield install with Chinese
  // profile name "BB84自用2" stored as
  //   selected_profile=@ByteArray(BB84\xe8\x87\xaa\xe7\x94\xa8\x32)
  // Earlier deploys (pre 2026-06-24 decodeIniValue \xHH upgrade) returned the
  // literal escaped form, causing readProfile to ENOENT on the wrong path. The
  // decoder upgrade fixed it; this test locks in the end-to-end path against the
  // exact byte sequence so the bug class cannot regress silently.
  it("BUG-23 Bug 1: resolves Chinese profile name encoded as @ByteArray(\\xHH)", async () => {
    const { bind } = await setupRoot({
      profiles: ["BB84自用2"],
      // The escaped form @ByteArray(BB84\xe8\x87\xaa\xe7\x94\xa8\x32)
      // decodes via decodeIniValue to "BB84自用2".
      selectedProfile: "BB84\\xe8\\x87\\xaa\\xe7\\x94\\xa8\\x32",
      allowedProfiles: ["Default"],
    });

    const response = await status({}, await bind());

    expect(response.ok).toBe(true);
    expect(response.result?.profile).toBe("BB84自用2");
    expect(response.result?.counts?.mods_total).toBe(2);
    // Critical: the error message in issue #12 contained literal `\xHH`. This
    // assertion proves the resolved profileName is the *decoded* form, not
    // the escaped wire form.
    expect(response.result?.profile).not.toMatch(/\\x[0-9a-fA-F]{2}/);
  });
});
