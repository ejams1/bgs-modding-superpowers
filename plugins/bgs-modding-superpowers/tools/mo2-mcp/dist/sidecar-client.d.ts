/**
 * Default virtual environment provisioned by scripts/bootstrap-python-venv.ps1.
 *
 * Kept under the same ~/.bgs-modding-superpowers root as the KB cache so the
 * interpreter survives plugin reinstalls and works when the plugin tree itself
 * is materialized read-only into a marketplace cache. If this path changes,
 * change it in the bootstrap script too — that script and this function are the
 * two halves of the same contract.
 */
export declare function defaultVenvPython(home?: string): string;
/**
 * Resolve the interpreter used to spawn the sidecar.
 *
 * Precedence:
 *   1. an explicit pythonPath passed by the caller (tests, custom deployments)
 *   2. $BGS_PYTHON, for a venv somewhere other than the default
 *   3. the bootstrapped venv, if it exists
 *   4. bare "python" off PATH
 *
 * Step 4 is the historical behaviour and is retained only as a fallback: it
 * requires the user to have installed mo2-mcp-sidecar into whatever interpreter
 * happens to be first on PATH. Steps 2 and 3 are what make an unconfigured
 * install work after running scripts/bootstrap-python-venv.ps1.
 *
 * Configured paths are honoured even if they do not exist on disk, so a typo in
 * $BGS_PYTHON surfaces as a clear spawn failure naming that path rather than
 * silently falling through to a different interpreter.
 */
export declare function resolveSidecarPython(opts?: {
    pythonPath?: string;
    home?: string;
}): string;
export type SidecarGame = "FALLOUT4" | "SKYRIM_SE" | "SKYRIM_LE" | "STARFIELD" | "OBLIVION" | "FALLOUT_NV";
export interface SidecarStartOptions {
    pythonPath?: string;
    modsRoot: string;
    profileDir?: string;
    game: SidecarGame;
}
export declare class SidecarClient {
    private proc?;
    private buffer;
    private pending;
    private nextId;
    private ready;
    private lastStartOptions?;
    private restartAttempts;
    private readonly maxRestarts;
    private stopping;
    private permanentFailed;
    private lastExitReason?;
    start(opts: SidecarStartOptions): Promise<void>;
    private launch;
    private onExit;
    private onData;
    call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
    isReady(): boolean;
    stop(): Promise<void>;
}
