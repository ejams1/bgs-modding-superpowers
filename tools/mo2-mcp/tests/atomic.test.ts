import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function loadAtomic(): Promise<typeof import("../src/atomic.js")> {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  return import("../src/atomic.js");
}

afterEach(() => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
});

describe("atomicWriteText", () => {
  it("creates file with content + creates missing parent dirs", async () => {
    const { atomicWriteText } = await loadAtomic();
    const dir = await createTrackedTempDir("atom-");
    const target = join(dir, "nested", "deep", "out.txt");

    await atomicWriteText(target, "hello world\n");

    expect(await readFile(target, "utf8")).toBe("hello world\n");
  });

  it("overwrites existing file", async () => {
    const { atomicWriteText } = await loadAtomic();
    const dir = await createTrackedTempDir("atom-");
    const target = join(dir, "out.txt");
    await writeFile(target, "old", "utf8");

    await atomicWriteText(target, "new");

    expect(await readFile(target, "utf8")).toBe("new");
  });

  it("leaves no temp files behind on success", async () => {
    const { atomicWriteText } = await loadAtomic();
    const dir = await createTrackedTempDir("atom-");
    const target = join(dir, "out.txt");

    await atomicWriteText(target, "data");

    const siblings = await readdir(dir);
    const leftovers = siblings.filter((s) => s.startsWith(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("preserves original content if rename fails", async () => {
    const dir = await createTrackedTempDir("atom-");
    const target = join(dir, "out.txt");
    await writeFile(target, "original", "utf8");

    vi.resetModules();
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      rename: async () => {
        throw new Error("simulated rename failure");
      },
    }));
    const { atomicWriteText } = await import("../src/atomic.js");

    await expect(atomicWriteText(target, "new content")).rejects.toThrow(/simulated/);
    expect(await readFile(target, "utf8")).toBe("original");
  });
});

describe("atomicWriteText profile line endings", () => {
  it.each(["modlist.txt", "plugins.txt", "loadorder.txt", "archives.txt"])(
    "keeps CRLF in an existing %s when given LF content",
    async (name) => {
      const { atomicWriteText } = await loadAtomic();
      const dir = await createTrackedTempDir("atom-");
      const target = join(dir, name);
      await writeFile(target, "+A\r\n+B\r\n", "utf8");

      await atomicWriteText(target, "+A\n+C\n");

      expect(await readFile(target, "utf8")).toBe("+A\r\n+C\r\n");
    },
  );

  it("keeps LF in an existing LF modlist.txt", async () => {
    const { atomicWriteText } = await loadAtomic();
    const dir = await createTrackedTempDir("atom-");
    const target = join(dir, "modlist.txt");
    await writeFile(target, "+A\n", "utf8");

    await atomicWriteText(target, "+A\r\n+B\r\n");

    expect(await readFile(target, "utf8")).toBe("+A\n+B\n");
  });

  it("does not double the CR when content is already CRLF", async () => {
    const { atomicWriteText } = await loadAtomic();
    const dir = await createTrackedTempDir("atom-");
    const target = join(dir, "modlist.txt");
    await writeFile(target, "+A\r\n", "utf8");

    await atomicWriteText(target, "+A\r\n+B\r\n");

    expect(await readFile(target, "utf8")).toBe("+A\r\n+B\r\n");
  });

  it("defaults a new profile file to CRLF on Windows and LF elsewhere", async () => {
    const { atomicWriteText } = await loadAtomic();
    const dir = await createTrackedTempDir("atom-");
    const target = join(dir, "modlist.txt");

    await atomicWriteText(target, "+A\n");

    expect(await readFile(target, "utf8")).toBe(process.platform === "win32" ? "+A\r\n" : "+A\n");
  });

  it("leaves other files alone", async () => {
    const { atomicWriteText } = await loadAtomic();
    const dir = await createTrackedTempDir("atom-");
    const target = join(dir, "meta.ini");
    await writeFile(target, "a\r\n", "utf8");

    await atomicWriteText(target, "a\nb\n");

    expect(await readFile(target, "utf8")).toBe("a\nb\n");
  });
});

describe("atomicWriteBytes", () => {
  it("writes binary content", async () => {
    const { atomicWriteBytes } = await loadAtomic();
    const dir = await createTrackedTempDir("atom-");
    const target = join(dir, "out.bin");

    await atomicWriteBytes(target, Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const content = await readFile(target);
    expect(Array.from(content)).toEqual([0x00, 0x01, 0x02, 0xff]);
  });

  it("leaves no temp files behind on success", async () => {
    const { atomicWriteBytes } = await loadAtomic();
    const dir = await createTrackedTempDir("atom-");
    const target = join(dir, "out.bin");

    await atomicWriteBytes(target, Buffer.from("binary"));

    const siblings = await readdir(dir);
    const leftovers = siblings.filter((s) => s.startsWith(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});
