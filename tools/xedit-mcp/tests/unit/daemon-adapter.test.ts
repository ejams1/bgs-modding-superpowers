import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile as writeFileReal } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMockAdapter } from "../fixtures/daemon-mock.js";

interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

interface SpawnBehavior {
  code?: number;
  stdout?: string;
  stderr?: string;
  writeResponse?: boolean;
  responseContent?: string;
  noClose?: boolean;
}

const spawnCalls: SpawnCall[] = [];
const spawnedChildren: FakeChild[] = [];
let spawnBehavior: (args: string[]) => SpawnBehavior | Promise<SpawnBehavior> = () => ({
  code: 0,
  writeResponse: true,
});

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
  });
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ command, args: [...args], options });
    const child = new FakeChild();
    spawnedChildren.push(child);
    queueMicrotask(async () => {
      const behavior = await spawnBehavior(args);
      if (behavior.writeResponse) {
        const resArg = args.find((a) => a.startsWith("-automation-call-response:"));
        const resPath = resArg!.slice("-automation-call-response:".length);
        await writeFileReal(
          resPath,
          behavior.responseContent ??
            JSON.stringify({ ok: true, command: "system.describe", result: {} }),
          "utf8",
        );
      }
      if (behavior.stdout) child.stdout.emit("data", Buffer.from(behavior.stdout));
      if (behavior.stderr) child.stderr.emit("data", Buffer.from(behavior.stderr));
      if (behavior.noClose) return;
      child.emit("close", behavior.code ?? 0);
    });
    return child;
  }),
}));

describe("daemon adapter (mock contract)", () => {
  it("returns the raw native ok envelope for a known command", async () => {
    const adapter = makeMockAdapter({
      "system.describe": () => ({ gameMode: "Fallout4", dataPath: "C:/x" }),
    });
    const res = await adapter.call({ command: "system.describe", args: {} });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect((res.result as { gameMode: string }).gameMode).toBe("Fallout4");
  });

  it("returns a native error envelope for an unknown command", async () => {
    const adapter = makeMockAdapter({});
    const res = await adapter.call({ command: "nope.nope", args: {} });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.error.code).toBe("unknown_command");
  });

  describe("createPowershellAdapter validation", () => {
    it("throws on non-positive timeoutSeconds at construction time", async () => {
      const { createPowershellAdapter } = await import("../../src/daemon-adapter.js");
      expect(() =>
        createPowershellAdapter({
          clientScript: "x",
          pid: 1,
          timeoutSeconds: 0,
        }),
      ).toThrow(/Invalid timeoutSeconds/);
      expect(() =>
        createPowershellAdapter({
          clientScript: "x",
          pid: 1,
          timeoutSeconds: -5,
        }),
      ).toThrow(/Invalid timeoutSeconds/);
      expect(() =>
        createPowershellAdapter({
          clientScript: "x",
          pid: 1,
          timeoutSeconds: Number.POSITIVE_INFINITY,
        }),
      ).toThrow(/Invalid timeoutSeconds/);
    });

    it("accepts a valid timeoutSeconds and omitted default", async () => {
      const { createPowershellAdapter } = await import("../../src/daemon-adapter.js");
      expect(() => createPowershellAdapter({ clientScript: "x", pid: 1 })).not.toThrow();
      expect(() =>
        createPowershellAdapter({
          clientScript: "x",
          pid: 1,
          timeoutSeconds: 60,
        }),
      ).not.toThrow();
    });
  });

  describe("createNativeAdapter validation", () => {
    it("throws on non-positive timeoutSeconds at construction time", async () => {
      const { createNativeAdapter } = await import("../../src/daemon-adapter.js");
      expect(() =>
        createNativeAdapter({
          xeditExecutable: "x",
          pid: 1,
          timeoutSeconds: 0,
        }),
      ).toThrow(/Invalid timeoutSeconds/);
      expect(() =>
        createNativeAdapter({
          xeditExecutable: "x",
          pid: 1,
          timeoutSeconds: -5,
        }),
      ).toThrow(/Invalid timeoutSeconds/);
      expect(() =>
        createNativeAdapter({
          xeditExecutable: "x",
          pid: 1,
          timeoutSeconds: Number.POSITIVE_INFINITY,
        }),
      ).toThrow(/Invalid timeoutSeconds/);
    });

    it("accepts a valid timeoutSeconds and omitted default", async () => {
      const { createNativeAdapter } = await import("../../src/daemon-adapter.js");
      expect(() => createNativeAdapter({ xeditExecutable: "x", pid: 1 })).not.toThrow();
      expect(() =>
        createNativeAdapter({
          xeditExecutable: "x",
          pid: 1,
          timeoutSeconds: 60,
        }),
      ).not.toThrow();
    });
  });

  describe("createNativeAdapter call() (direct xEdit.exe spawn, no pwsh hop)", () => {
    let scratchDir: string;

    beforeEach(async () => {
      spawnCalls.length = 0;
      spawnedChildren.length = 0;
      spawnBehavior = () => ({ code: 0, writeResponse: true });
      scratchDir = await mkdtemp(join(tmpdir(), "xedit-mcp-native-test-"));
      vi.resetModules();
    });

    afterEach(async () => {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    });

    it("spawns xeditExecutable directly (not pwsh) with colon-joined argv and windowsHide: true", async () => {
      const { createNativeAdapter } = await import("../../src/daemon-adapter.js");
      const adapter = createNativeAdapter({
        xeditExecutable: "C:/xEdit/xEdit.exe",
        pid: 4242,
        scratchDir,
      });

      const res = await adapter.call({ command: "system.describe", args: {} });
      expect(res.ok).toBe(true);

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0]!;
      expect(call.command).toBe("C:/xEdit/xEdit.exe");
      expect(call.options).toMatchObject({ windowsHide: true });
      expect(call.args).toHaveLength(3);
      expect(call.args[0]).toBe("-automation-call-pid:4242");
      expect(call.args[1]).toMatch(/^-automation-call-request:/);
      expect(call.args[2]).toMatch(/^-automation-call-response:/);
      // Each flag+value must be a single argv element (colon-joined), matching
      // xedit-client.call.ps1's $startInfo.ArgumentList - never split into a
      // separate "--flag" "value" pair like the pwsh adapter's flags.
      for (const arg of call.args) {
        expect(arg.includes(" ")).toBe(false);
      }
    });

    it("reads and parses the response file, stripping a UTF-8 BOM", async () => {
      spawnBehavior = () => ({
        code: 0,
        writeResponse: true,
        responseContent:
          "\uFEFF" +
          JSON.stringify({ ok: true, command: "system.describe", result: { gameMode: "Fallout4" } }),
      });
      const { createNativeAdapter } = await import("../../src/daemon-adapter.js");
      const adapter = createNativeAdapter({
        xeditExecutable: "C:/xEdit/xEdit.exe",
        pid: 4242,
        scratchDir,
      });

      const res = await adapter.call({ command: "system.describe", args: {} });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      expect((res.result as { gameMode: string }).gameMode).toBe("Fallout4");
    });

    it("rejects with a stderr/stdout tail when the child exits non-zero", async () => {
      spawnBehavior = () => ({
        code: 3,
        writeResponse: false,
        stdout: "some stdout tail",
        stderr: "boom stderr tail",
      });
      const { createNativeAdapter } = await import("../../src/daemon-adapter.js");
      const adapter = createNativeAdapter({
        xeditExecutable: "C:/xEdit/xEdit.exe",
        pid: 4242,
        scratchDir,
      });

      await expect(adapter.call({ command: "system.describe", args: {} })).rejects.toThrow(
        /xEdit automation-call exited 3[\s\S]*boom stderr tail[\s\S]*some stdout tail/,
      );
    });

    it("kills the child and rejects on timeout when it never exits", async () => {
      spawnBehavior = () => ({ noClose: true });
      const { createNativeAdapter } = await import("../../src/daemon-adapter.js");
      const adapter = createNativeAdapter({
        xeditExecutable: "C:/xEdit/xEdit.exe",
        pid: 4242,
        scratchDir,
        timeoutSeconds: 0.05,
      });

      await expect(adapter.call({ command: "system.describe", args: {} })).rejects.toThrow(
        /Timed out waiting for automation-call response after 0.05 seconds/,
      );
      expect(spawnedChildren).toHaveLength(1);
      expect(spawnedChildren[0]!.kill).toHaveBeenCalled();
    });
  });
});
