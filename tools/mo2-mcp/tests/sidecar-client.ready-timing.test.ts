import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

// Regression coverage for review finding L6: launch() used to resolve via a
// setTimeout(checkReady, 50) poll loop instead of resolving directly from
// onData() when the `{"ready": true}` line arrives. These tests assert the
// promise settles as soon as the ready line is observed (not tied to any
// poll tick), and that the startup-timeout/exit-before-ready rejection path
// still works.

type FakeProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
};

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

function makeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  proc.kill = vi.fn();
  proc.stdin = { end: vi.fn(), write: vi.fn() };
  return proc;
}

describe("SidecarClient ready timing (L6)", () => {
  it("resolves launch() as soon as the ready line arrives, not on a 50ms poll tick", async () => {
    vi.useFakeTimers();
    try {
      const proc = makeProc();
      spawnMock.mockReset();
      spawnMock.mockReturnValue(proc);
      const { SidecarClient } = await import("../src/sidecar-client.js");
      const client = new SidecarClient();

      let resolved = false;
      const start = client.start({ modsRoot: "/tmp/mods", game: "FALLOUT4" }).then(() => {
        resolved = true;
      });

      proc.stdout.emit("data", '{"ready":true}\n');

      // Flush microtasks without advancing any timers at all. The old
      // implementation relied on a setTimeout(checkReady, 50) poll and would
      // still be unresolved at this point; the fixed implementation resolves
      // synchronously off the onData callback.
      await vi.advanceTimersByTimeAsync(0);

      expect(resolved).toBe(true);
      expect(client.isReady()).toBe(true);
      await start;
    } finally {
      vi.useRealTimers();
    }
  });

  it("still rejects if the sidecar exits before the ready line arrives", async () => {
    const proc = makeProc();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(proc);
    const { SidecarClient } = await import("../src/sidecar-client.js");
    const client = new SidecarClient();

    const start = client.start({ modsRoot: "/tmp/mods", game: "FALLOUT4" });
    const assertion = expect(start).rejects.toThrow(/sidecar exited before ready/);

    proc.emit("exit", 1, null);

    await assertion;
    expect(client.isReady()).toBe(false);
  });
});
