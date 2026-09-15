import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("detectMo2Running root scoping", () => {
  afterEach(async () => {
    const { clearDetectionCache } = await import("../src/detection.js");
    clearDetectionCache();
    vi.resetModules();
    execFileMock.mockReset();
    vi.useRealTimers();
  });

  it("ignores ModOrganizer processes whose executable path is outside mo2Root", async () => {
    execFileMock.mockImplementation((file: string, _args: string[], maybeCallback: any, maybeCallback2?: any) => {
      const callback = typeof maybeCallback === "function" ? maybeCallback : maybeCallback2;
      if (file === "tasklist") {
        callback(null, { stdout: '"ModOrganizer.exe","1234","Console","1","100 K"', stderr: "" });
        return {};
      }
      callback(null, { stdout: JSON.stringify([{ Id: 1234, Path: String.raw`C:\OtherMO2\ModOrganizer.exe` }]), stderr: "" });
      return {};
    });
    const { detectMo2Running } = await import("../src/detection.js");

    const result = await detectMo2Running({ mo2Root: String.raw`C:\TargetMO2` });

    expect(result.processRunning).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.sharedMemoryPresent).toBe("unknown");
    expect(result.profileLockHeld).toBe(false);
    expect(result.confidence).toBe("low");
  });

  it("reports profileLockHeld when the configured profile modlist has an exclusive lock", async () => {
    execFileMock.mockImplementation((file: string, args: string[], maybeCallback: any, maybeCallback2?: any) => {
      const callback = typeof maybeCallback === "function" ? maybeCallback : maybeCallback2;
      const command = args.join("\n");
      if (file === "tasklist") {
        callback(null, { stdout: '"ModOrganizer.exe","1234","Console","1","100 K"', stderr: "" });
        return {};
      }
      if (command.includes("modlist.txt")) {
        callback(null, { stdout: "locked\n", stderr: "" });
        return {};
      }
      callback(null, { stdout: JSON.stringify([{ Id: 1234, Path: String.raw`C:\TargetMO2\ModOrganizer.exe` }]), stderr: "" });
      return {};
    });
    const { detectMo2Running } = await import("../src/detection.js");

    const result = await detectMo2Running({
      mo2Root: String.raw`C:\TargetMO2`,
      profileDir: String.raw`C:\TargetMO2\profiles\Default`,
    });

    expect(result.processRunning).toBe(true);
    expect(result.pid).toBe(1234);
    expect(result.sharedMemoryPresent).toBe("unknown");
    expect(result.profileLockHeld).toBe(true);
    expect(result.confidence).toBe("medium");
  });

  it("caches back-to-back calls within the TTL so pwsh is only spawned once", async () => {
    execFileMock.mockImplementation((file: string, args: string[], maybeCallback: any, maybeCallback2?: any) => {
      const callback = typeof maybeCallback === "function" ? maybeCallback : maybeCallback2;
      callback(null, { stdout: JSON.stringify([{ Id: 1234, Path: String.raw`C:\TargetMO2\ModOrganizer.exe` }]), stderr: "" });
      return {};
    });
    const { detectMo2Running } = await import("../src/detection.js");

    const first = await detectMo2Running({ mo2Root: String.raw`C:\TargetMO2` });
    const second = await detectMo2Running({ mo2Root: String.raw`C:\TargetMO2` });

    expect(first.pid).toBe(1234);
    expect(second).toEqual(first);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does not share a cached result across different profileDir values for the same mo2Root", async () => {
    execFileMock.mockImplementation((file: string, args: string[], maybeCallback: any, maybeCallback2?: any) => {
      const callback = typeof maybeCallback === "function" ? maybeCallback : maybeCallback2;
      const command = args.join("\n");
      if (command.includes("modlist.txt")) {
        callback(null, { stdout: "unlocked\n", stderr: "" });
        return {};
      }
      callback(null, { stdout: JSON.stringify([{ Id: 1234, Path: String.raw`C:\TargetMO2\ModOrganizer.exe` }]), stderr: "" });
      return {};
    });
    const { detectMo2Running } = await import("../src/detection.js");

    await detectMo2Running({
      mo2Root: String.raw`C:\TargetMO2`,
      profileDir: String.raw`C:\TargetMO2\profiles\A`,
    });
    await detectMo2Running({
      mo2Root: String.raw`C:\TargetMO2`,
      profileDir: String.raw`C:\TargetMO2\profiles\B`,
    });

    // Each distinct profileDir is its own cache key: process-list + lock-probe spawn per call (2 x 2 = 4).
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("does not share a cached result across different mo2Root values", async () => {
    execFileMock.mockImplementation((file: string, _args: string[], maybeCallback: any, maybeCallback2?: any) => {
      const callback = typeof maybeCallback === "function" ? maybeCallback : maybeCallback2;
      callback(null, { stdout: "[]", stderr: "" });
      return {};
    });
    const { detectMo2Running } = await import("../src/detection.js");

    await detectMo2Running({ mo2Root: String.raw`C:\RootA` });
    await detectMo2Running({ mo2Root: String.raw`C:\RootB` });

    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("re-spawns pwsh once the cached entry's TTL has elapsed", async () => {
    vi.useFakeTimers();
    execFileMock.mockImplementation((file: string, _args: string[], maybeCallback: any, maybeCallback2?: any) => {
      const callback = typeof maybeCallback === "function" ? maybeCallback : maybeCallback2;
      callback(null, { stdout: JSON.stringify([{ Id: 1234, Path: String.raw`C:\TargetMO2\ModOrganizer.exe` }]), stderr: "" });
      return {};
    });
    const { detectMo2Running } = await import("../src/detection.js");

    await detectMo2Running({ mo2Root: String.raw`C:\TargetMO2` });
    await vi.advanceTimersByTimeAsync(301);
    await detectMo2Running({ mo2Root: String.raw`C:\TargetMO2` });

    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
