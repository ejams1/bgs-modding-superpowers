import { describe, expect, it } from "vitest";
import { decodeIniValue, readMo2GamePath, resolveMo2DataPath } from "../../src/mo2-ini.js";

describe("mo2-ini gamePath resolution", () => {
  it("decodes @ByteArray with doubled backslashes (real MO2 2.5 ini shape)", () => {
    expect(decodeIniValue("@ByteArray(M:\\\\Modlists\\\\fo4-litr-AE\\\\Stock Game Folder)"))
      .toBe("M:\\Modlists\\fo4-litr-AE\\Stock Game Folder");
  });

  it("decodes \\xHH byte escapes as UTF-8", () => {
    expect(decodeIniValue("@ByteArray(D:\\\\Games\\\\\\xe8\\x87\\xaa)")).toBe("D:\\Games\\自");
  });

  it("passes plain values through untouched", () => {
    expect(decodeIniValue("M:/plain/path")).toBe("M:/plain/path");
  });

  it("reads gamePath only from [General], ignoring same key in other sections", () => {
    const ini = [
      "[Other]",
      "gamePath=@ByteArray(C:\\\\wrong)",
      "[General]",
      "gameName=Fallout 4",
      "gamePath=@ByteArray(M:\\\\Modlists\\\\fo4-litr-AE\\\\Stock Game Folder)",
      "[Settings]",
      "gamePath=C:/alsowrong",
    ].join("\r\n");
    expect(readMo2GamePath("unused", ini)).toBe("M:\\Modlists\\fo4-litr-AE\\Stock Game Folder");
  });

  it("normalizes forward slashes and strips quotes and trailing separators", () => {
    const ini = '[General]\ngamePath="M:/Modlists/x/Stock Game Folder/"\n';
    expect(readMo2GamePath("unused", ini)).toBe("M:\\Modlists\\x\\Stock Game Folder");
  });

  it("returns undefined when gamePath is absent or empty", () => {
    expect(readMo2GamePath("unused", "[General]\ngameName=Fallout 4\n")).toBeUndefined();
    expect(readMo2GamePath("unused", "[General]\ngamePath=\n")).toBeUndefined();
  });

  it("returns undefined for a missing ini rather than throwing", () => {
    expect(readMo2GamePath("Z:/definitely/not/a/real/mo2/root")).toBeUndefined();
    expect(resolveMo2DataPath("Z:/definitely/not/a/real/mo2/root")).toBeUndefined();
    expect(resolveMo2DataPath(undefined)).toBeUndefined();
  });
});
