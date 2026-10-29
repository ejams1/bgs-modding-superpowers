/**
 * Atomic file write helpers — TS parallel to Python sidecar's atomic.py.
 *
 * Pattern: mkdir parent if needed -> write to sibling .tmp-XXXX -> fsync -> rename.
 * os.rename is atomic on NTFS + POSIX for same-volume same-directory renames.
 *
 * Used by every offline-path T2/T3 tool in S4/S5 (mo2_set_mod_notes,
 * mo2_edit_meta, mo2_profile_ini_set, mo2_toggle_mod, mo2_install, etc.).
 */
import { mkdir, readFile, rename, open, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { randomBytes } from "node:crypto";
/** Profile list files MO2 reads and writes with CRLF line endings. */
const PROFILE_LINE_FILES = new Set(["modlist.txt", "plugins.txt", "loadorder.txt", "archives.txt"]);
/**
 * Line ending a profile file should keep: the one the existing file uses, else CRLF on Windows
 * (what MO2 writes) and LF elsewhere.
 */
async function detectEol(path) {
    try {
        const existing = await readFile(path, "utf8");
        if (existing.includes("\r\n"))
            return "\r\n";
        if (existing.includes("\n"))
            return "\n";
    }
    catch {
        // Missing or unreadable: fall through to the platform default.
    }
    return process.platform === "win32" ? "\r\n" : "\n";
}
/**
 * Atomically write text content to `path`. Creates parent dirs if missing.
 * For modlist.txt, plugins.txt, loadorder.txt and archives.txt the line endings are normalised to those of
 * the file being replaced, so callers can build content with "\n" without turning MO2's CRLF files into LF.
 */
export async function atomicWriteText(path, content, encoding = "utf8") {
    await mkdir(dirname(path), { recursive: true });
    if (PROFILE_LINE_FILES.has(basename(path).toLowerCase())) {
        const eol = await detectEol(path);
        content = content.replace(/\r?\n/g, eol);
    }
    const tmp = tempPath(path);
    try {
        const fh = await open(tmp, "w");
        try {
            await fh.writeFile(content, { encoding });
            await fh.sync();
        }
        finally {
            await fh.close();
        }
        await rename(tmp, path);
    }
    catch (err) {
        await cleanupTemp(tmp);
        throw err;
    }
}
/** Atomically write binary content to `path`. */
export async function atomicWriteBytes(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = tempPath(path);
    try {
        const fh = await open(tmp, "w");
        try {
            await fh.writeFile(content);
            await fh.sync();
        }
        finally {
            await fh.close();
        }
        await rename(tmp, path);
    }
    catch (err) {
        await cleanupTemp(tmp);
        throw err;
    }
}
function tempPath(target) {
    const dir = dirname(target);
    const ext = extname(target);
    const stamp = randomBytes(6).toString("hex");
    return join(dir, `.tmp-${stamp}${ext}`);
}
async function cleanupTemp(tmp) {
    try {
        await unlink(tmp);
    }
    catch {
        // Best effort: do not mask original write/rename error.
    }
}
