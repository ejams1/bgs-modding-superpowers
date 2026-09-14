import { readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * Decode a Qt QSettings-style ini value. MO2 writes paths as
 * `@ByteArray(M:\\Modlists\\x\\Stock Game Folder)` (doubled backslashes) and
 * non-ASCII bytes as `\xHH`. Mirrors mo2-mcp's decodeIniValue; duplicated
 * here because xedit-mcp is a standalone package with no dependency on
 * mo2-mcp.
 */
export function decodeIniValue(value) {
    const byteArray = value.match(/^@ByteArray\((.*)\)$/);
    if (!byteArray)
        return value;
    const escaped = byteArray[1];
    const bytes = [];
    let i = 0;
    while (i < escaped.length) {
        const ch = escaped[i];
        if (ch === "\\") {
            if (i + 3 < escaped.length && escaped[i + 1] === "x") {
                const hex = escaped.substring(i + 2, i + 4);
                if (/^[0-9a-fA-F]{2}$/.test(hex)) {
                    bytes.push(parseInt(hex, 16));
                    i += 4;
                    continue;
                }
            }
            if (i + 1 < escaped.length && escaped[i + 1] === "\\") {
                bytes.push(0x5c);
                i += 2;
                continue;
            }
            bytes.push(0x5c);
            i += 1;
            continue;
        }
        const code = ch.charCodeAt(0);
        if (code < 0x80) {
            bytes.push(code);
        }
        else {
            const enc = new TextEncoder().encode(ch);
            for (let j = 0; j < enc.length; j++)
                bytes.push(enc[j]);
        }
        i += 1;
    }
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}
/** Read `[General] gamePath` from `<moRoot>/ModOrganizer.ini`, or undefined. */
export function readMo2GamePath(moRoot, iniText) {
    let text = iniText;
    if (text === undefined) {
        try {
            text = readFileSync(join(moRoot, "ModOrganizer.ini"), "utf-8");
        }
        catch {
            return undefined;
        }
    }
    let inGeneral = false;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith("[")) {
            inGeneral = /^\[General\]$/i.test(line);
            continue;
        }
        if (!inGeneral)
            continue;
        const eq = line.indexOf("=");
        if (eq <= 0 || line.slice(0, eq).trim() !== "gamePath")
            continue;
        const decoded = decodeIniValue(line.slice(eq + 1).trim()).replace(/^"(.*)"$/, "$1").trim();
        if (!decoded)
            return undefined;
        return decoded.replace(/\//g, "\\").replace(/[\\]+$/, "");
    }
    return undefined;
}
/**
 * Default `-D:` for xEdit: `<gamePath>\Data` from MO2's own config. Without
 * this, xEdit falls back to the registry-discovered install (the raw Steam
 * library), which MO2's VFS does not virtualize - so it loads only the
 * vanilla masters + Creation Club files and none of the profile's mods.
 */
export function resolveMo2DataPath(moRoot) {
    if (!moRoot)
        return undefined;
    const gamePath = readMo2GamePath(moRoot);
    return gamePath ? join(gamePath, "Data") : undefined;
}
//# sourceMappingURL=mo2-ini.js.map