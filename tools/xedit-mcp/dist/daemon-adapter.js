import { spawn } from "node:child_process";
import { writeFile, readFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
/**
 * Production adapter: invokes the xedit-client.ps1 automation call subcommand with
 * file-based request/response. Flags verified against
 * tools/mo2-vfs-launcher/lib/xedit-client.call.ps1 at implementation time:
 * --xedit-pid, --request-file, --response-file, and required --timeout-seconds.
 *
 * Kept as a fallback for one release behind BGS_XEDIT_FORCE_PWSH_ADAPTER; see
 * createNativeAdapter below, which drops the pwsh hop this adapter pays on every
 * call (see finding L4 in docs/internal/reviews/2026-09-14-inherited-project-review.md).
 */
export function createPowershellAdapter(opts) {
    const pwsh = opts.pwshExe ?? "pwsh";
    const timeoutSeconds = opts.timeoutSeconds ?? 30;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new Error(`Invalid timeoutSeconds: ${opts.timeoutSeconds}. Must be a positive finite number.`);
    }
    return {
        async call({ command, args, requestId }) {
            const scratch = opts.scratchDir ?? join(tmpdir(), "xedit-mcp-calls");
            await mkdir(scratch, { recursive: true });
            const fileId = randomUUID();
            const reqPath = join(scratch, `${fileId}.req.json`);
            const resPath = join(scratch, `${fileId}.res.json`);
            const request = buildRequestBody({ command, args, requestId, mcpToken: opts.mcpToken, fileId });
            try {
                await writeFile(reqPath, JSON.stringify(request), "utf8");
                await runPwsh(pwsh, [
                    "-NoProfile",
                    "-File",
                    opts.clientScript,
                    // Subcommand discovered from xedit-client.ps1 dispatch.
                    "automation",
                    "call",
                    // Flag names verified against xedit-client.call.ps1 param block.
                    "--xedit-pid",
                    String(opts.pid),
                    "--request-file",
                    reqPath,
                    "--response-file",
                    resPath,
                    "--timeout-seconds",
                    String(timeoutSeconds),
                ]);
                return await readAndParseResponse(resPath);
            }
            finally {
                // Best-effort cleanup so the token-bearing request file never lingers.
                await unlink(reqPath).catch(() => { });
                await unlink(resPath).catch(() => { });
            }
        },
    };
}
function buildRequestBody(params) {
    const request = {
        command: params.command,
        args: params.args ?? {},
        requestId: params.requestId ?? params.fileId,
    };
    if (params.mcpToken)
        request.mcpToken = params.mcpToken;
    return request;
}
/**
 * Reads and parses a daemon response file. Shared by both adapters: xEdit writes
 * the response file as UTF-8 *with BOM* on Windows regardless of which adapter
 * launched it, so the leading 0xFEFF must be stripped before JSON.parse.
 */
async function readAndParseResponse(resPath) {
    const raw = await readFile(resPath, "utf8");
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    try {
        return JSON.parse(stripped);
    }
    catch (parseErr) {
        throw new Error(`Daemon response at ${resPath} was not valid JSON: ${parseErr.message}. ` +
            `First 200 bytes: ${stripped.slice(0, 200)}`);
    }
}
/**
 * Native adapter: spawns xEdit.exe directly in -automation-call-* mode, dropping
 * the pwsh hop that createPowershellAdapter pays on every call (measured 390-421 ms
 * per call — see finding L4 in
 * docs/internal/reviews/2026-09-14-inherited-project-review.md). Argv shape verified
 * against tools/mo2-vfs-launcher/lib/xedit-client.call.ps1's Invoke-XeditClientAutomationCall
 * $startInfo.ArgumentList: three single colon-joined elements, no pwsh in between.
 *
 * This adapter is only ever constructed by launchDaemon with a PID and executable
 * path it just launched itself, so (unlike the general-purpose ps1 client) it does
 * not re-verify the PID belongs to a real xEdit process.
 */
export function createNativeAdapter(opts) {
    const timeoutSeconds = opts.timeoutSeconds ?? 30;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new Error(`Invalid timeoutSeconds: ${opts.timeoutSeconds}. Must be a positive finite number.`);
    }
    return {
        async call({ command, args, requestId }) {
            const scratch = opts.scratchDir ?? join(tmpdir(), "xedit-mcp-calls");
            await mkdir(scratch, { recursive: true });
            const fileId = randomUUID();
            const reqPath = join(scratch, `${fileId}.req.json`);
            const resPath = join(scratch, `${fileId}.res.json`);
            const request = buildRequestBody({ command, args, requestId, mcpToken: opts.mcpToken, fileId });
            try {
                await writeFile(reqPath, JSON.stringify(request), "utf8");
                await runXeditAutomationCall(opts.xeditExecutable, [
                    `-automation-call-pid:${opts.pid}`,
                    `-automation-call-request:${reqPath}`,
                    `-automation-call-response:${resPath}`,
                ], timeoutSeconds);
                return await readAndParseResponse(resPath);
            }
            finally {
                // Best-effort cleanup so the token-bearing request file never lingers.
                await unlink(reqPath).catch(() => { });
                await unlink(resPath).catch(() => { });
            }
        },
    };
}
function runXeditAutomationCall(xeditExecutable, args, timeoutSeconds) {
    return new Promise((resolve, reject) => {
        const child = spawn(xeditExecutable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill();
            reject(new Error(`Timed out waiting for automation-call response after ${timeoutSeconds} seconds`));
        }, timeoutSeconds * 1000);
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            callback();
        };
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", (code) => {
            if (code === 0) {
                finish(resolve);
                return;
            }
            const tail = (s) => s.trim().slice(-500);
            finish(() => reject(new Error(`xEdit automation-call exited ${code}.\n` +
                (stderr ? `[stderr] ${tail(stderr)}\n` : "") +
                (stdout ? `[stdout] ${tail(stdout)}\n` : ""))));
        });
    });
}
function runPwsh(pwsh, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(pwsh, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            const tail = (s) => s.trim().slice(-500);
            reject(new Error(`xedit-client.ps1 exited ${code}.\n` +
                (stderr ? `[stderr] ${tail(stderr)}\n` : "") +
                (stdout ? `[stdout] ${tail(stdout)}\n` : "")));
        });
    });
}
//# sourceMappingURL=daemon-adapter.js.map