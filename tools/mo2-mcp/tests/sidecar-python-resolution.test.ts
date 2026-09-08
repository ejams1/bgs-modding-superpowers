import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultVenvPython, resolveSidecarPython } from "../src/sidecar-client.js";

/**
 * Builds a fake home directory containing a bootstrapped venv interpreter at
 * the exact path defaultVenvPython() probes for this platform.
 */
function makeHomeWithVenv(): string {
  const home = mkdtempSync(join(tmpdir(), "bgs-venv-home-"));
  const python = defaultVenvPython(home);
  mkdirSync(join(python, ".."), { recursive: true });
  writeFileSync(python, "");
  return home;
}

describe("resolveSidecarPython", () => {
  const savedEnv = process.env.BGS_PYTHON;
  const tempHomes: string[] = [];

  beforeEach(() => {
    delete process.env.BGS_PYTHON;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.BGS_PYTHON;
    else process.env.BGS_PYTHON = savedEnv;
    while (tempHomes.length) {
      rmSync(tempHomes.pop()!, { recursive: true, force: true });
    }
  });

  it("falls back to bare python when nothing is configured or bootstrapped", () => {
    const home = mkdtempSync(join(tmpdir(), "bgs-venv-empty-"));
    tempHomes.push(home);
    expect(resolveSidecarPython({ home })).toBe("python");
  });

  it("prefers the bootstrapped venv over bare python", () => {
    const home = makeHomeWithVenv();
    tempHomes.push(home);
    expect(resolveSidecarPython({ home })).toBe(defaultVenvPython(home));
  });

  it("prefers BGS_PYTHON over the bootstrapped venv", () => {
    const home = makeHomeWithVenv();
    tempHomes.push(home);
    process.env.BGS_PYTHON = "D:\\custom\\python.exe";
    expect(resolveSidecarPython({ home })).toBe("D:\\custom\\python.exe");
  });

  it("honours BGS_PYTHON even when the path does not exist, so typos surface", () => {
    const home = makeHomeWithVenv();
    tempHomes.push(home);
    process.env.BGS_PYTHON = "/nonexistent/python";
    expect(resolveSidecarPython({ home })).toBe("/nonexistent/python");
  });

  it("lets an explicit pythonPath win over every other source", () => {
    const home = makeHomeWithVenv();
    tempHomes.push(home);
    process.env.BGS_PYTHON = "D:\\custom\\python.exe";
    expect(resolveSidecarPython({ pythonPath: "explicit-python", home })).toBe("explicit-python");
  });

  it("ignores blank configuration rather than spawning an empty command", () => {
    const home = mkdtempSync(join(tmpdir(), "bgs-venv-blank-"));
    tempHomes.push(home);
    process.env.BGS_PYTHON = "   ";
    expect(resolveSidecarPython({ pythonPath: "  ", home })).toBe("python");
  });

  it("resolves the platform-correct venv interpreter layout", () => {
    const python = defaultVenvPython("/home/user");
    if (process.platform === "win32") {
      expect(python).toMatch(/Scripts[\\/]python\.exe$/);
    } else {
      expect(python).toMatch(/bin[\\/]python$/);
    }
  });
});
