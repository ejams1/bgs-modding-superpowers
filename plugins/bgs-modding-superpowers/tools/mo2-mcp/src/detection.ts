/**
 * MO2-running detection ladder (Windows-only).
 *
 *   Signal A: process list scoped to the configured MO2 root.
 *   Signal B: shared-memory probe for mod_organizer_instance_<game_id>.
 *   Signal C: profile file exclusive-lock probe.
 *
 * Signal B is deliberately reported as "unknown" for now.  The MO2 singleton
 * name depends on the internal game id, and guessing it would recreate the same
 * unscoped false-positive class that this detector exists to prevent.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Short-lived cache for detectMo2Running results, keyed by mo2Root+profileDir.
 *
 * detectMo2Running shells out to pwsh (Get-Process, and optionally a profile
 * lock probe) which is expensive relative to the callers that invoke it back
 * to back within the same tool call (mo2_clone_profile, mo2_configure_executable,
 * binding.ts). A short TTL lets those bursts reuse one result without letting
 * the cache go stale enough to misreport a process that just started/exited.
 */
const DETECTION_CACHE_TTL_MS = 300;
const detectionCache = new Map<string, { result: DetectionResult; expiresAt: number }>();

function detectionCacheKey(opts: DetectionOptions): string {
  return `${opts.mo2Root}::${opts.profileDir ?? ""}`;
}

/** Test-only helper: clears the detectMo2Running result cache. */
export function clearDetectionCache(): void {
  detectionCache.clear();
}

export interface DetectionResult {
  processRunning: boolean;
  sharedMemoryPresent: boolean | "unknown";
  profileLockHeld: boolean;
  pid: number | null;
  confidence: "high" | "medium" | "low";
  /** Back-compat broker gate: true when a root-scoped MO2 process is present. */
  online: boolean;
}

export interface DetectionOptions {
  mo2Root: string;
  /** Optional profile dir; signal C lock check is skipped if absent. */
  profileDir?: string;
}

export interface Mo2ProcessInfo {
  pid: number;
  path: string | null;
}

export async function detectMo2Running(opts: DetectionOptions): Promise<DetectionResult> {
  const cacheKey = detectionCacheKey(opts);
  const cached = detectionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const result = await detectMo2RunningUncached(opts);
  detectionCache.set(cacheKey, { result, expiresAt: Date.now() + DETECTION_CACHE_TTL_MS });
  return result;
}

async function detectMo2RunningUncached(opts: DetectionOptions): Promise<DetectionResult> {
  const processes = await listMo2ProcessesAtRoot(opts.mo2Root);
  const processRunning = processes.length > 0;
  const pid = processes[0]?.pid ?? null;
  // TODO: implement the MO2 singleton shared-memory probe once the internal
  // game-id mapping is derived from ModOrganizer.ini rather than guessed.
  const sharedMemoryPresent: "unknown" = "unknown";
  let profileLockHeld = false;

  if (processRunning && opts.profileDir) {
    try {
      const profilePath = opts.profileDir.replace(/\\/g, "\\\\").replace(/'/g, "''");
      const psScript = `
        try {
          $f = [System.IO.File]::Open('${profilePath}\\modlist.txt', 'Open', 'Read', 'None')
          $f.Close()
          Write-Output 'unlocked'
        } catch { Write-Output 'locked' }
      `;
      const { stdout } = await execFileP("pwsh", ["-NoProfile", "-Command", psScript]);
      profileLockHeld = stdout.toString().trim() === "locked";
    } catch {
      // Unknown profile-lock state; keep signal C false.
    }
  }

  return {
    processRunning,
    sharedMemoryPresent,
    profileLockHeld,
    pid,
    confidence: detectionConfidence(processRunning, sharedMemoryPresent, profileLockHeld),
    online: processRunning,
  };
}

export async function listMo2ProcessesAtRoot(mo2Root: string): Promise<Mo2ProcessInfo[]> {
  try {
    const psScript = `
      Get-Process -Name "ModOrganizer*" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path } |
        Select-Object -Property Id,Path |
        ConvertTo-Json -Compress
    `;
    const { stdout } = await execFileP("pwsh", ["-NoProfile", "-Command", psScript]);
    const rows = parsePowerShellJson(stdout.toString());
    return rows
      .map((row) => ({ pid: Number(row.Id), path: typeof row.Path === "string" ? row.Path : null }))
      .filter((row): row is Mo2ProcessInfo => Number.isInteger(row.pid) && row.pid > 0 && isPathUnderRoot(row.path, mo2Root));
  } catch {
    // Without executable paths we cannot safely scope a process to mo2Root, so
    // fail closed instead of falling back to unscoped tasklist matching.
    return [];
  }
}

function parsePowerShellJson(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as Record<string, unknown> | Array<Record<string, unknown>>;
  return Array.isArray(parsed) ? parsed : [parsed];
}

function isPathUnderRoot(path: string | null, mo2Root: string): boolean {
  if (!path) return false;
  const root = normalizeWindowsPath(mo2Root);
  const candidate = normalizeWindowsPath(path);
  return candidate === root || candidate.startsWith(`${root}\\`);
}

function normalizeWindowsPath(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase();
}

function detectionConfidence(
  processRunning: boolean,
  sharedMemoryPresent: boolean | "unknown",
  profileLockHeld: boolean,
): "high" | "medium" | "low" {
  const positiveSignals = [processRunning, sharedMemoryPresent === true, profileLockHeld].filter(Boolean).length;
  if (positiveSignals >= 3) return "high";
  if (positiveSignals >= 2) return "medium";
  return "low";
}
