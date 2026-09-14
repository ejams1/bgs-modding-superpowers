# Inherited-project review — findings and remediation plan

**Date:** 2026-09-14
**Branch / commit reviewed:** `main` @ `47bcd8b` (clean working tree)
**Sources:**

- **Local review** (this session): whole-repo survey of correctness, execution time, and token usage. Every measurement below was taken on this machine (Windows 11, Node 25.2.1, PowerShell 7.6.5).
- **Ultra review** (`/code-review ultra`, multi-agent cloud review): scoped to the most recent commit, `47bcd8b fix(mo2-control-plane): mods.create no longer hangs on an unregistered mod folder`. Its raw JSON output is reproduced verbatim in Appendix A.

**Baseline verified before review:**

| Check | Result |
|---|---|
| `tools/xedit-mcp` vitest | 191 passed, 6 skipped (integration, gated) |
| `tools/bgs-kb-mcp` vitest | 137 passed, 4 skipped |
| `tools/mo2-mcp` vitest | 612 passed, 19 skipped |
| Ultra review: new ps1 harness, 46 vitest (create-mod/separator/install), `tsc --noEmit`, broker pytest | all pass (pytest 99 passed, 7 skipped) |
| Tracked `tools/*/dist` vs fresh `tsc` build from `src` | identical for all three servers |
| MCP server cold start (initialize round-trip) | xedit 223 ms, bgs_kb 229 ms, mo2 212 ms |

---

## How to read this document

Each finding has an ID, a severity, the file and line it anchors to, what is wrong, how to reproduce it, and the proposed fix with a rough effort estimate. Severity scale:

- **P0** — broken for end users right now, or a hang/data-loss path.
- **P1** — wrong result returned as success, or a dead-end error path.
- **P2** — measurable performance or token cost.
- **P3** — hygiene, duplication, or diagnostics quality.

Section 5 is the ordered work plan that covers every item.

---

## 1. Broken now (local review)

### L1 — Shipped plugin tree is four commits stale  `P0`

- **Where:** `plugins/bgs-modding-superpowers/` (tracked, generated mirror); installed copy at `~/.claude/plugins/cache/bgs-modding-superpowers/bgs-modding-superpowers/0.2.0`.
- **What:** The mirror was last regenerated at `57e662a`. Commits `c316d95` (xedit_stop/restart cancel an in-flight launch), `9ae36f0` + `fbcf67f` (default `-D:` to MO2 `gamePath\Data`), and `47bcd8b` (mods.create hang fix) changed `tools/` only. The installed plugin cache is older still (`33dac1c`). Concretely: the mirror's `tools/xedit-mcp/dist/` has no `mo2-ini.js`, and its `tools/mo2-mcp/dist/tools/mo2-create-mod.js` and `live-bridge/mo2_agent_control.py` predate the hang fix. The ultra review reached the same conclusion independently (U5).
- **Repro:**
  ```
  git log --oneline 534a9f3..HEAD -- tools skills scripts .mcp.json hooks knowledge
  git log --oneline 534a9f3..HEAD -- plugins
  diff -rq tools/xedit-mcp/dist plugins/bgs-modding-superpowers/tools/xedit-mcp/dist
  grep -rc adopt_existing plugins/bgs-modding-superpowers/tools/mo2-mcp/src   # 0 hits
  ```
- **Fix:** Run `scripts/build-portable-plugin.ps1`, commit the regenerated tree, bump the version, reinstall the plugin. Then make this impossible to forget: add a CI/pre-push check that fails when `tools/`, `skills/`, `hooks/`, or `knowledge/` changed in a commit range but `plugins/` did not, or fold the regeneration into `scripts/bump-version.sh`.
- **Effort:** 10 min to regenerate; 30 min for the guard.

### L2 — Session-start hook prints nothing on Windows  `P0`

- **Where:** `hooks/run-hook.cmd:9-12` (and the identical mirror copy).
- **What:** `set "BOOTSTRAP=..."` is inside the `if /I ... ( ... )` block. `cmd.exe` expands `%BOOTSTRAP%` when it parses the block, before the `set` runs, so `if exist ""` is always false and the bootstrap SKILL.md is never emitted. The hook is registered for `startup|clear|compact`, so the per-session bootstrap the README and skills rely on never reaches the agent on Claude Code for Windows.
- **Repro (verified):**
  ```powershell
  (cmd /c '"C:\...\hooks\run-hook.cmd" session-start' | Out-String).Length   # 0
  ```
  Moving the `set "BOOTSTRAP=..."` line above the `if` and re-running yields 17,699 bytes.
- **Fix:** Move the `set` out of the parenthesized block (or `setlocal EnableDelayedExpansion` and use `!BOOTSTRAP!`). Add a smoke test under `tests/` that runs the hook and asserts non-empty output. **Do L6 first**, because fixing this adds ~4.4k tokens to every session start, clear, and compaction.
- **Effort:** 2 min for the fix, 15 min for the test.

### L3 — Opening Claude Code inside this repo fails all three MCP servers  `P0` (dev-only)

- **Where:** root `.mcp.json`; `.claude/settings.local.json`.
- **What:** The root `.mcp.json` doubles as the plugin manifest (the marketplace cache root *is* the repo root) and uses `${CLAUDE_PLUGIN_ROOT}`. When Claude Code opens this directory as a project it also reads that file as a project config, where the variable is undefined. The path resolves to `/plugins/bgs-modding-superpowers/tools/<server>/dist/index.js`, node exits immediately, and the harness reports `CONNECTION_CLOSED` for `xedit`, `bgs_kb`, and `mo2`. The plugin-loaded copies (`plugin_bgs-modding-superpowers_*`) connect fine. `.claude/settings.local.json` currently lists the three servers under `enabledMcpjsonServers`, which opts in to the broken copies.
- **Repro:** Open Claude Code in the repo; the session banner lists the three servers as failed. Or `ls /plugins/bgs-modding-superpowers/tools/xedit-mcp/dist/index.js` → not found.
- **Fix:** In `.claude/settings.local.json` change `enabledMcpjsonServers` to `disabledMcpjsonServers` (same three names). Document in CONTRIBUTING.md that in-repo dev sessions use the installed plugin's servers. If in-repo servers are wanted (to test unreleased `tools/` builds), add a separate `.claude/mcp.dev.json` with absolute or `./tools/...` paths.
- **Effort:** 1 min; 10 min with docs.

---

## 2. Hang and correctness findings from the ultra review (commit `47bcd8b`)

All line numbers are as reported by the ultra review against `47bcd8b`.

### U1 — Second `createMod` call site is still unguarded  `P0`

- **Where:** `tools/mo2-control-plane/live-bridge/mo2_agent_control.py:2245` (`_handle_installation_create_mod_from_directory`); `tools/mo2-mcp/src/tools/mo2-install.ts:352-357`; `KNOWN_BLOCKER_DIALOGS` at line 112.
- **What:** The commit guards `mods.create` only. `installation.create_mod_from_directory` still calls `organizer.createMod` on an unregistered folder, which opens MO2's modal "Mod Exists" dialog on the main thread. mo2-install's live apply branch never re-checks `existsSync` before the pipe call (only the offline branch at line 364 does), and `KNOWN_BLOCKER_DIALOGS` has no "Mod Exists" entry as a backstop.
- **Repro:** `mo2_install` plan passes the existsSync check at plan time; `mods/<name>` appears unregistered before apply (hand-dropped folder, or any pipe client calling the method directly) → `getMod(sanitized)` is None → `createMod` opens the modal → pump blocks, pipe call times out, staging dir left behind, GUI stuck until a human clicks.
- **Fix:** Extract the new detection into `_existing_unregistered_mod_dir(organizer, name)` and call it in front of both `createMod` sites. Add "Mod Exists" to `KNOWN_BLOCKER_DIALOGS`. Re-check `existsSync` in the live apply branch of mo2-install.
- **Effort:** 30 min plus a live MO2 check.

### U2 — Stale broker silently ignores `adopt_existing`  `P0`

- **Where:** `tools/mo2-mcp/src/tools/mo2-create-mod.ts:92`.
- **What:** `applyMutation` sends `adopt_existing: true` but never checks the result's `adopted`/`created` flags. A previously deployed bridge drops unknown payload keys, so against a stale broker the flag is ignored and the original modal hang recurs while the tool description promises it "never triggers MO2's modal". mo2-install detects stale brokers via `method_not_found` (lines 451-453); this path has no equivalent because `capabilities.json` publishes method names only.
- **Repro:** MO2 still running the pre-commit `mo2_agent_control.py` + `mods/<name>` present unregistered + `adopt_existing: true` → old broker reads only name/priority → reaches `createMod` → modal blocks the pump → pipe timeout.
- **Fix:** Throw when `adopt_existing` was sent but `result.adopted !== true && result.created !== true`, with a "redeploy the control plane" hint. Longer term, publish a bridge contract version in `capabilities.json` and check it.
- **Effort:** 20 min.

### U3 — Existence guard fails open  `P0`

- **Where:** `mo2_agent_control.py:1280`.
- **What:** `organizer.modsPath` is wrapped in a bare `except Exception: candidate = None`. If the method is missing, not callable, or raises, `existing_dir` stays None and control falls through to `createMod` — the very hang this commit fixes — with no log line indicating the guard was skipped. No other handler wraps organizer methods this way; `mo2_assets_inspector/bridge.py:48` calls `modsPath()` directly.
- **Repro:** A mobase build/proxy without `modsPath`, or `modsPath()` raising, with `mods/<name>` present unregistered → `candidate = None` → `createMod` → modal → pipe timeout, indistinguishable from the pre-fix bug.
- **Fix:** Fail closed: return `INTERNAL_ERROR "cannot verify mods directory"`. Or call `organizer.modsPath()` directly like the rest of the file and let exceptions surface.
- **Effort:** 10 min.

### U4 — Plan time never checks whether the folder exists  `P1`

- **Where:** `mo2-create-mod.ts:68` (`buildPlan`); contrast `mo2-install.ts:264-268`.
- **What:** With an unregistered folder present and `adopt_existing` unset, `buildPlan` mints a "Create empty mod X" plan with a lease that is guaranteed to fail at apply, contradicting the file's own BUG-9 comment (lines 63-66). `resolveModsDir` is already imported. `plan-apply.ts` has no generic target-existence preflight (`computeLease` fingerprints `modlist.txt` only).
- **Repro:** `mods/DroppedInByHand` exists unregistered; plan `{name: 'DroppedInByHand'}` → ok, diff "Create empty mod DroppedInByHand", lease token → user approves → apply throws the broker's "mod folder already exists on disk but is not registered" refusal.
- **Fix:** In `buildPlan`, `existsSync(join(modsDir, name))` → refuse with the same message (and suggest `adopt_existing`) unless the flag is set, in which case the diff should say "Adopt existing folder X".
- **Effort:** 20 min with a test.

### U5 — Portable plugin copy not regenerated  `P0`

Same as **L1**. The ultra review adds: all three `plugins/` copies (mo2-mcp `src`, `dist`, and the live bridge) have zero occurrences of `adopt_existing`, so a plugin-root install ships the old `.strict()` schema (rejects `adopt_existing`) *and* the hang-prone bridge. `docs/internal/roadmap.md:128` describes the intended two-commit cycle (source commit + materialized commit). Fix as in L1.

### U6 — Case-insensitive NTFS vs case-sensitive `getMod`  `P1`

- **Where:** `mo2_agent_control.py:1263`, `1282`, `1296`.
- **What:** `os.path.isdir` is case-insensitive on NTFS but both `getMod` lookups use the exact requested string (upstream MO2 `ModInfo::s_ModsByName` is a case-sensitive map). A request whose case differs from a registered folder is misreported as "exists on disk but is not registered", and with `adopt_existing = true` fails with `INTERNAL_ERROR "refresh did not register existing folder"` even though MO2 has it registered. The ps1 `FakeModList.getMod` is an exact dict lookup, so the harness cannot catch this.
- **Repro:** Mod registered as `MyMod`; client sends `{name: 'mymod'}` → `getMod('mymod')` None → `isdir(mods/mymod)` True → refusal tells the user to pass `adopt_existing` → user does → refresh registers nothing new → still None → `INTERNAL_ERROR`. Neither message names the real cause.
- **Fix:** Confirm live that `modList().getMod('mymod')` returns None for a registered `MyMod`. Then resolve the on-disk entry name via a casefold match over `os.listdir(modsPath)` and use that canonical name for `getMod` and the response.
- **Effort:** 30 min plus live check.

### U7 — `adopt_existing` with no folder silently creates a new mod  `P1`

- **Where:** `mo2_agent_control.py:1284`.
- **What:** When `existing_dir is None`, the adopt path falls through to the normal `createMod` and returns `created: true, adopted: false`. A caller whose intent was "register what is already there" gets a T3 creation on a typo'd name with no signal.
- **Repro:** `{name: 'DropedInByHand' (typo), adopt_existing: true}` → `getMod` None → folder absent → `createMod` at line 1315 → `ok: true, created: true`. The TS plan diff still reads "(adopt_existing: register the folder if it already exists on disk)" and apply reports success. No harness case covers adopt with a missing folder.
- **Fix:** Decide the semantics and enforce them. Recommended: `adopt_existing` with no folder → `INVALID_PARAMS "adopt_existing set but mods/<name> does not exist"`. Add the harness case.
- **Effort:** 15 min.

### U8 — Adopt branch ignores `setPriority` return  `P1`

- **Where:** `mo2_agent_control.py:1309`; contrast `_handle_mods_set_priority` lines 1045-1049.
- **What:** The adopt branch (copied from the create branch) ignores the bool from `IModList.setPriority` and never compares the resulting priority to the requested one, so a rejected priority returns `ok: true` with `priority != requested_priority` and no error or noop flag — the same silent-noop class already filed in `docs/issues/BUG-mo2-mcp-send_plugin_to-silent-noop-2026-07-05.md`.
- **Repro:** `adopt_existing: true` with `wins_over` resolved from a stale `modlist.txt` → out-of-range priority → `setPriority` returns False → result `{ok: true, priority: <unchanged>, requested_priority: N}` → `mo2-create-mod.ts` never reads `result.priority` back and logs "→ priority N" as if applied.
- **Fix:** Check the return and the resulting priority in both branches; return `PRIORITY_NOT_APPLIED` like `_handle_mods_set_priority`. In TS, read `result.priority` back and surface a mismatch. (Shared with U15.)
- **Effort:** 20 min.

### U9 — Apply log misreports adoption as creation  `P1` (diagnostics)

- **Where:** `mo2-create-mod.ts:108` (`logApplyEvent`).
- **What:** After an adopt apply whose result is `{created: false, adopted: true, priority: N}`, the log line still says `created "<name>" ... → priority <targetPri>`, so MO2's apply log misstates an adoption as a creation and reports the requested rather than actual priority.
- **Repro:** Adopt an existing folder → `_handle_system_log_apply` (bridge lines 868-880) writes `APPLY tool=mo2_create_mod ... created "X" wins_over=none → priority none`.
- **Fix:** Branch the log message on `result.adopted` and print `result.priority`.
- **Effort:** 10 min.

### U10 — Separator tool cannot follow the broker's advice  `P1`

- **Where:** `tools/mo2-mcp/src/tools/mo2-create-separator.ts:22-28`, `92-93`.
- **What:** `mo2_create_separator` calls `mods.create` with `<name>_separator`, its plan schema is `.strict()` with no `adopt_existing`, and the broker error is rethrown verbatim. The new refusal text instructs the caller to "pass adopt_existing=true", a parameter this tool rejects.
- **Repro:** Stale unregistered `mods/<Section>_separator` (left by an aborted apply or hand copy) → apply → broker returns `invalid_params '... pass adopt_existing=true ...'` → agent retries with the flag → zod strict rejects → dead end. Previously this hung; now it errors with advice that cannot be followed.
- **Fix:** Plumb `adopt_existing` through the separator schema and payload, or have the broker message not prescribe a caller-specific parameter (pair with U12's dedicated error code so the TS layer can add its own hint).
- **Effort:** 20 min.

### U11 — Adopt registers unknown folder contents blind  `P2`

- **Where:** `mo2_agent_control.py:1301`; tool description still says "Create empty mod".
- **What:** `adopt_existing` registers whatever the stale folder contains and the result reports only name/created/adopted/priority/absolute_path — no inventory. There is no supported path to obtain an *empty* mod at a name whose stale folder exists (MO2's own dialog offers Merge/Replace/Rename). Mitigated only by MO2 registering refreshed mods disabled.
- **Repro:** Curator wants a clean empty `PatchHub` but `mods/PatchHub` is a stale leftover with plugins and loose files → without the flag, refused; with it, the folder's assets are registered with no inventory in the response.
- **Fix:** Include a short inventory (file count, plugin names, total bytes) in the adopt result and in the TS apply output. Update the tool description. Consider a `replace_existing` mode that moves the stale folder to `.artifacts/quarantine/<name>-<ts>` and creates a fresh empty mod.
- **Effort:** 45 min.

### U12 — Recoverable refusal reuses `INVALID_PARAMS`  `P2`

- **Where:** `mo2_agent_control.py:1286`; `mo2-create-mod.ts:93` discards `error.code`.
- **What:** The one recoverable condition this commit introduces (retry with `adopt_existing`) shares its code with "name already exists" and every type error, so it is distinguishable only by string-matching the message. The ps1 harness itself asserts on `-match 'Mod Exists'` / `-match 'adopt_existing'` (lines 153-157), so a wording tweak silently breaks the test and any caller keyed on the text.
- **Fix:** Add `ErrorCode.MOD_DIR_EXISTS_UNREGISTERED`, carry `existing_dir` in `error.details`, have the TS layer branch on the code, and update the harness to assert on the code.
- **Effort:** 20 min.

### U13 — `organizer.refresh()` unguarded in the adopt path  `P2`

- **Where:** `mo2_agent_control.py:1295` (and pre-existing at 1336 for the create path); contrast `_handle_mods_rename` lines 1135-1139.
- **What:** `refresh()` is called bare inside `_on_main_thread`; if it raises, the pump re-raises (lines 246-247) into the handler's outer except which returns `MAIN_THREAD_UNAVAILABLE` — the code reserved for a blocked pump — so the client treats MO2 as hung rather than the adopt as failed.
- **Repro:** `refresh()` raises (e.g. a mod folder with an unreadable `meta.ini` during model rebuild) → client receives `main_thread_unavailable` with the refresh exception text. No field evidence yet.
- **Fix:** Wrap `refresh()` in try/except in one shared tail and return `INTERNAL_ERROR` with the message.
- **Effort:** 10 min (folds into U15).

### U14 — Rollback of an adopt plan leaves `meta.ini` and registration behind  `P2`

- **Where:** `mo2-create-mod.ts:76` (`targets`/`affectedFiles`); `snapshot.ts:66-72, 102-118`.
- **What:** The plan lists only `modlist.txt`, but adopting via `refresh()` writes `mods/<name>/meta.ini` into a folder that had none and registers the mod. Snapshot restores only listed sources, so `mo2_rollback` reverts the modlist line and leaves the new `meta.ini` and registration behind. Pre-existing gap shared with the create path and `mo2-create-separator`; `mo2-install.ts:300` by contrast lists `destPath`.
- **Repro:** Adopt a hand-dropped folder without `meta.ini` → refresh creates it → rollback restores `modlist.txt` only → folder stays registered.
- **Fix:** Add `join(modsDir, name)` to `affectedFiles` for create, adopt, and separator plans; the existing absent/directory snapshot logic then covers all three.
- **Effort:** 20 min with a test.

### U15 — Duplicated create/adopt tails and inline detection  `P3`

- **Where:** `mo2_agent_control.py:1275-1283` (detection), `1300-1313` and `1337-1349` (tails); `1296` + `1300` call `organizer.modList()` twice back to back.
- **What:** The adopt tail is a token-for-token copy of the create tail apart from variable names and flags. The next priority-reporting fix (U8) lands in one branch and diverges in the other. The inconsistent `modList()` re-fetch implies to readers that `refresh()` invalidates the handle while the create branch contradicts it.
- **Fix:** Collapse both into one shared tail taking `(mod, name, absolute_path, created, adopted)`, lift detection into `_existing_unregistered_mod_dir(organizer, name)` (used by U1), and guard `refresh()` there (U13).
- **Effort:** 30 min. Do this first within the bridge work so U1, U3, U6, U7, U8, U13 each land once.

---

## 3. Execution-time opportunities (local review)

### L4 — Every xEdit tool call pays two process spawns  `P2`

- **Where:** `tools/xedit-mcp/src/daemon-adapter.ts` (`createPowershellAdapter`, `runPwsh`); `tools/mo2-vfs-launcher/lib/xedit-client.call.ps1:3-34`; the readiness loop in `tools/xedit-mcp/src/launch.ts:230-285`.
- **What:** Per call: Node writes a request file → spawns `pwsh -NoProfile -File xedit-client.ps1 automation call ...` (loads the 987-line client script tree) → PowerShell `Start-Process`es a *second* `xEdit.exe` in `-automation-call-*` mode that relays to the daemon and writes the response file → PowerShell parses it with `ConvertFrom-Json` (result discarded) → Node reads and parses the same file again. Measured cost of the pwsh hop alone, excluding the xEdit client process: 390-421 ms per call (bare `pwsh -NoProfile` is 187 ms). The launch readiness loop spawns pwsh the same way for every `process wait` poll, plus a 750 ms sleep, and the Phase-B `files.list` poll goes through the full adapter every 1.5 s.
- **Repro:**
  ```
  time pwsh -NoProfile -File tools/mo2-vfs-launcher/xedit-client.ps1 automation call \
    --xedit-pid 999999 --request-file req.json --response-file res.json --timeout-seconds 1
  ```
- **Fix (tiered):**
  1. Spawn `xEdit.exe -automation-call-pid:<pid> -automation-call-request:<req> -automation-call-response:<res>` directly from Node with `windowsHide: true`, dropping the pwsh hop and the double JSON parse. Keep the ps1 path as a fallback behind an env flag for one release. Saves ~0.4 s per call and per readiness poll.
  2. Poll readiness with `system.describe` through the same direct spawn and drop the `process wait` pwsh call.
  3. Longer term: speak the daemon's named-pipe protocol from Node and eliminate the xEdit client process as well (protocol is documented in `docs/internal/superpowers/specs/2026-05-13-xedit-native-adoption-design.md`).
- **Effort:** tier 1 about 1 hour plus a live conflict-audit run; tier 3 half a day.

### L5 — Windows PID liveness shells out to `tasklist`  `P2`

- **Where:** `tools/mo2-mcp/src/lease-lock.ts:145-165` (`isPidAlive`); `detection.ts` (`detectMo2Running`, also via `tasklist`).
- **What:** Each check spawns `tasklist /FI "PID eq N"` (372 ms in `detection.test.ts`). `process.kill(pid, 0)` is supported on Windows in Node and returns EPERM for alive-but-inaccessible processes, which the non-Windows branch already handles.
- **Fix:** Use the signal branch on all platforms for `isPidAlive`. For `detectMo2Running`, which needs the image name, keep `tasklist` but cache the result for a few hundred ms so tools that call it back to back (`mo2_clone_profile`, `mo2_configure_executable`, binding) do not each pay for it.
- **Effort:** 15 min plus updating the test that asserts on tasklist output.

### L6 — Sidecar readiness polls a flag every 50 ms  `P3`

- **Where:** `tools/mo2-mcp/src/sidecar-client.ts:159-166`.
- **What:** `launch()` resolves via a `setTimeout(checkReady, 50)` loop instead of resolving from `onData` when the `ready` line arrives. Adds up to 50 ms and a timer per launch. Cosmetic.
- **Fix:** Store the resolver and call it from `onData` when `msg.ready === true`.
- **Effort:** 10 min.

---

## 4. Token-usage opportunities (local review)

Measured per-session context cost of what this plugin injects (tool schemas measured by `tools/list` against each server; 4 chars ≈ 1 token):

| Source | Bytes | Approx tokens |
|---|---|---|
| mo2 tool schemas (38 tools) | 19,616 | 4,900 |
| xedit tool schemas (17 tools) | 18,978 | 4,745 |
| bgs_kb tool schemas (5 tools) | 4,002 | 1,000 |
| Bootstrap skill via session hook (once L2 is fixed) | 17,699 | 4,400 |
| **Total** | | **~15,000 per session start, clear, and compaction** |

Largest single tool descriptions: `xedit_find_records_by_pattern` 2,838 bytes, `xedit_restart` 2,527, `xedit_create_child_record` 2,303, `xedit_start` 2,224, `xedit_find_record` 1,632, `mo2_configure_executable` 1,346, `mo2_install` 1,233.

### L7 — Trim the bootstrap skill before fixing the hook  `P2`

- **Where:** `skills/using-bgs-modding-superpowers/SKILL.md` (244 lines, 17.7 KB).
- **What:** The hook re-injects the whole file on every `startup`, `clear`, and `compact`. Lines 20-42 repeat the skill table that the harness already lists with each skill's description; lines 44-108 repeat the xEdit and KB tool descriptions that are already in context as tool schemas. Only "Hard rules" (110-165) and "Canonical lifecycle pattern" (75-96) carry information the agent cannot get elsewhere.
- **Fix:** Cut the file to the hard rules, the lifecycle pattern, and a one-line pointer to each task skill by name. Target ≤ 6 KB (~1,500 tokens). Keep the full reference content in a separate `reference.md` inside the skill directory for on-demand reading.
- **Effort:** 30 min.

### L8 — Move daemon-contract notes out of tool descriptions  `P2`

- **Where:** `tools/xedit-mcp/src/index.ts` tool registrations and `tools/xedit-mcp/src/tools/*.ts` zod `.describe()` strings; `tools/mo2-mcp/src/tools/*.ts`.
- **What:** Descriptions carry contract-version commentary ("daemon contract 0.21 rejects limit > 100 as invalid_request", "supports.conflictStatusChildGroup, contract 0.15", "Phase-15-style") that belongs in `xedit-automation` SKILL.md or the KB, not in every session's tool list. Several xedit tools repeat the same "Requires the daemon to be ready ... fast-fails with code='not_ready'" sentence.
- **Fix:** One-sentence purpose per tool, parameter descriptions ≤ 15 words, contract notes moved to the skill. Add a unit test that fails when any tool's serialized schema exceeds 1,200 bytes. Expected saving ≈ 30% (~3,000 tokens).
- **Effort:** 1.5 hours across both servers.

### L9 — Unbounded response sizes  `P2`

- **Where:** `tools/xedit-mcp/src/tools/find-records-by-pattern.ts:196-268` (`drainAll` cap 20 pages / 2,000 matches); `tools/mo2-mcp/src/tools/mo2-modlist.ts`, `mo2-pluginlist.ts`, `mo2-search-files.ts` (no `limit`/`offset`).
- **What:** `drainAll` returns up to 2,000 full match objects in a single tool result. `mo2_modlist` and `mo2_pluginlist` return the entire list every call. Fine for small packs; a 500-mod pack turns each list into several thousand tokens per call.
- **Fix:** Add `limit`/`offset` (default 100) and a `fields` or `compact` option to the list tools; add `compact: true` (locator + EditorID only) to `drainAll`; lower the default drain cap to 500 matches and require an explicit `maxMatches` to go higher.
- **Effort:** 1 hour with tests.

### L10 — Dev-only: doubled tool registration risk  `P3`

Once L3 is resolved by *fixing* rather than disabling the project config, every tool would be registered twice (plugin copy + project copy), doubling the ~10.6k tokens of schemas. Prefer the disable route in L3.

---

## 5. Work plan (ordered, covers every item above)

Each step is bounded; do them in order. Estimates are for one person with the repo already built.

| # | Step | Covers | Est. |
|---|---|---|---|
| 1 | Disable the project-scoped MCP servers in `.claude/settings.local.json`; note it in CONTRIBUTING.md | L3, L10 | 10 min |
| 2 | Trim the bootstrap skill, then fix the batch expansion bug in `hooks/run-hook.cmd`, add a hook smoke test | L7, L2 | 45 min |
| 3 | Bridge refactor in `mo2_agent_control.py`: lift `_existing_unregistered_mod_dir` (casefold match, fail closed), one shared create/adopt tail with guarded `refresh()` and `setPriority` check, dedicated error code, adopt-without-folder refusal, apply to both `createMod` sites, add "Mod Exists" to blocker dialogs | U1, U3, U6, U7, U8, U12, U13, U15 | 2 h + live MO2 check |
| 4 | TS side of mo2-create-mod: plan-time existence check, adopt-result verification (stale broker guard), branch on the new error code, correct apply log, add mod dir to `affectedFiles` (create, adopt, separator), read `result.priority` back, inventory in adopt output, updated description | U2, U4, U9, U11, U14 | 1.5 h |
| 5 | Plumb `adopt_existing` through `mo2_create_separator` (or rely on the error-code hint from step 3) | U10 | 20 min |
| 6 | Re-check `existsSync` in mo2-install's live apply branch | U1 (TS half) | 10 min |
| 7 | Regenerate `plugins/` with `scripts/build-portable-plugin.ps1`, bump version, reinstall; add a guard that fails when `tools/`/`skills/`/`hooks/`/`knowledge/` change without `plugins/` | L1, U5 | 40 min |
| 8 | Direct `xEdit.exe -automation-call` spawn from Node (drop the pwsh hop), readiness polling through the same path | L4 tier 1-2 | 1 h + live audit run |
| 9 | `isPidAlive` via `process.kill(pid, 0)`; short-lived cache for `detectMo2Running` | L5 | 20 min |
| 10 | Slim tool descriptions with a schema-size unit test | L8 | 1.5 h |
| 11 | Paging and compact modes for list tools and `drainAll` | L9 | 1 h |
| 12 | Sidecar ready resolver from `onData` | L6 | 10 min |
| 13 | (Backlog) Node named-pipe client for the xEdit daemon | L4 tier 3 | half a day |

Steps 1-7 restore correctness for end users (about 6 hours). Steps 8-12 are the performance and token work (about 4 hours). Step 13 is optional.

---

## Appendix A — Ultra review raw output (verbatim)

Reviewed target: `main` @ `47bcd8b`. Final tally after the sweep: 16 surviving candidates, cut to the 15 most severe (dropped the weakest cleanup item — the ps1-vs-pytest harness duplication, where both styles are established repo conventions). Test status: the new ps1 harness passes, vitest (46 tests across create-mod/separator/install) passes, `tsc --noEmit` is clean, and the broker pytest suite passes (99 passed, 7 skipped, run via `uv run --with pytest --with jsonschema`). No CLAUDE.md governs the changed files.

```json
[
  {
    "file": "tools/mo2-control-plane/live-bridge/mo2_agent_control.py",
    "line": 2245,
    "summary": "The bridge's other IOrganizer.createMod call site, _handle_installation_create_mod_from_directory, is left unguarded, so the exact 'Mod Exists' modal hang this commit fixes for mods.create remains reachable via installation.create_mod_from_directory; mo2-install.ts's live apply branch (line 352-357) never re-checks existsSync before the pipe call (only the offline branch at 364 does), and KNOWN_BLOCKER_DIALOGS (line 112) has no 'Mod Exists' entry to act as a backstop.",
    "failure_scenario": "mo2_install plan passes existsSync at plan time, then mods/<name> appears unregistered before apply (hand-dropped folder, or any pipe client calling the method directly) -> getMod(sanitized) is None -> organizer.createMod(GuessedString(sanitized)) opens the modal 'Mod Exists' dialog on the main thread -> pump blocks, pipe call times out, staging dir left behind, GUI stuck until a human clicks. Fix: extract the new detection into a shared helper and call it in front of both createMod sites (and optionally whitelist the dialog in KNOWN_BLOCKER_DIALOGS)."
  },
  {
    "file": "tools/mo2-mcp/src/tools/mo2-create-mod.ts",
    "line": 92,
    "summary": "applyMutation sends adopt_existing:true but never checks that the broker honoured it (result.adopted/result.created), and a previously deployed bridge silently drops unknown payload keys, so against a stale broker the flag is ignored and the original modal hang recurs while the tool description promises it 'never triggers MO2's modal'.",
    "failure_scenario": "MO2 still running the pre-commit mo2_agent_control.py (no redeploy/restart after this change) + mods/<name> present unregistered + adopt_existing:true -> old broker reads only name/priority, reaches createMod, 'Mod Exists' modal blocks the pump, pipe call times out. mo2-install.ts:451-453 detects stale brokers via method_not_found and logs a redeploy hint; this path has no equivalent (capabilities.json publishes method names only). Cheap guard: throw when adopt_existing was sent but result.adopted !== true && result.created !== true."
  },
  {
    "file": "tools/mo2-mcp/src/tools/mo2-create-mod.ts",
    "line": 68,
    "summary": "buildPlan never checks whether <modsDir>/<name> already exists on disk, so with an unregistered folder present and adopt_existing unset it mints a 'Create empty mod X' plan with a lease that is guaranteed to fail at apply, contradicting the file's own BUG-9 comment (lines 63-66) and the plan-time existsSync guard mo2-install.ts:264-268 already uses; resolveModsDir is already imported.",
    "failure_scenario": "mods/DroppedInByHand exists unregistered; plan {name:'DroppedInByHand'} -> ok with diff 'Create empty mod DroppedInByHand' and a lease token -> user approves -> apply throws the broker's 'mod folder already exists on disk but is not registered' refusal. plan-apply.ts has no generic target-existence preflight (computeLease only fingerprints modlist.txt)."
  },
  {
    "file": "tools/mo2-mcp/src/tools/mo2-create-separator.ts",
    "line": 92,
    "summary": "mo2_create_separator calls mods.create with '<name>_separator' and its plan schema (lines 22-28) is .strict() with no adopt_existing, so the broker's new refusal text instructs the caller to 'pass adopt_existing=true' — a parameter this tool rejects — and the error is rethrown verbatim (line 93) with no in-tool recovery path.",
    "failure_scenario": "Stale unregistered mods/<Section>_separator folder (left by an aborted apply or hand copy) -> mo2_create_separator apply -> broker returns invalid_params '... pass adopt_existing=true to register the existing folder as-is instead' -> agent retries with adopt_existing -> zod strict rejects the unknown key -> dead end; previously this hung, now it errors with advice that cannot be followed. Either plumb the flag through the separator schema/payload or make the broker message not prescribe a caller-specific parameter."
  },
  {
    "file": "plugins/bgs-modding-superpowers/tools/mo2-mcp/dist/tools/mo2-create-mod.js",
    "line": 1,
    "summary": "The git-tracked portable plugin copy (plugins/.../tools/mo2-mcp/src + dist and plugins/.../live-bridge/mo2_agent_control.py) was not regenerated, and .mcp.json:13 launches the mo2 MCP server from ${CLAUDE_PLUGIN_ROOT}/plugins/bgs-modding-superpowers/tools/mo2-mcp/dist/index.js while install-mo2-control-plane.ps1 deploys the bridge from the same tree it lives in — so a plugin-root install ships the old .strict() schema (rejects adopt_existing) and the hang-prone bridge.",
    "failure_scenario": "User on a plugin install calls mo2_create_mod {mode:'plan', name:'X', adopt_existing:true} -> zod strict rejects adopt_existing; the deployed bridge still reaches createMod on an unregistered folder and hangs. All three plugins/ copies have zero occurrences of 'adopt_existing'. docs/internal/roadmap.md:128 describes a two-commit cycle (source commit + materialized commit), so this is a required follow-up before the fix is usable from the plugin; README.md:70 says the mirror happens 'on every release'."
  },
  {
    "file": "tools/mo2-control-plane/live-bridge/mo2_agent_control.py",
    "line": 1282,
    "summary": "os.path.isdir is case-insensitive on NTFS but both getMod lookups (line 1263 before, line 1296 after refresh) use the exact requested string with no case folding, so a request whose case differs from an existing/registered folder is misreported as 'exists on disk but is not registered' and, with adopt_existing=true, fails with INTERNAL_ERROR 'refresh did not register existing folder' even though MO2 has it registered.",
    "failure_scenario": "Mod registered as 'MyMod'; client sends {name:'mymod'} -> getMod('mymod') None (upstream MO2 ModInfo::s_ModsByName is a case-sensitive std::map<QString,...>) -> isdir(mods/mymod) True -> refusal tells the user to pass adopt_existing -> user does -> refresh registers nothing new -> getMod('mymod') still None -> INTERNAL_ERROR; neither message names the real cause (case mismatch). The ps1 FakeModList.getMod is an exact dict lookup and only the exact-case name is tested. Confirm with a live check that modList().getMod('mymod') returns None for a registered 'MyMod'; fix by resolving the on-disk entry name via os.listdir casefold match and using that for getMod."
  },
  {
    "file": "tools/mo2-control-plane/live-bridge/mo2_agent_control.py",
    "line": 1284,
    "summary": "adopt_existing=true with NO folder on disk silently falls through to the normal createMod path and creates a brand-new empty mod (created:true, adopted:false) instead of erroring, so a caller whose intent was 'register what is already there' gets a T3 creation on a typo'd name with no signal.",
    "failure_scenario": "Client sends {name:'DropedInByHand' (typo), adopt_existing:true} -> getMod None -> `if existing_dir is not None:` is False -> organizer.createMod(...) at line 1315 -> ok:true, created:true, adopted:false; the TS plan diff still read '(adopt_existing: register the folder if it already exists on disk)' and apply returns success. Neither the harness (refused/adopted/fresh/bad-flag only) nor the tool description covers adopt_existing with a missing folder."
  },
  {
    "file": "tools/mo2-control-plane/live-bridge/mo2_agent_control.py",
    "line": 1280,
    "summary": "The guard fails OPEN: if organizer.modsPath is missing/not callable or raises (bare `except Exception: candidate = None`), existing_dir stays None and control falls through to createMod — the very modal hang this commit fixes recurs with no log line or error indicating the guard was skipped; no other handler wraps organizer methods this way and mo2_assets_inspector/bridge.py:48 calls organizer.modsPath() directly.",
    "failure_scenario": "A mobase build/proxy without modsPath, or modsPath() raising, with mods/<name> present unregistered -> candidate=None -> organizer.createMod(GuessedString(sanitized_name)) -> 'Mod Exists' modal blocks the pump -> pipe timeout, indistinguishable from the pre-fix bug. Fail closed (return INTERNAL_ERROR 'cannot verify mods directory') or at least log.warning; simpler still, call organizer.modsPath() directly like the rest of the file."
  },
  {
    "file": "tools/mo2-control-plane/live-bridge/mo2_agent_control.py",
    "line": 1309,
    "summary": "The adopt branch (copying the create branch) ignores the bool return of IModList.setPriority and never compares the resulting priority to the requested one, so a rejected priority returns ok:true with priority != requested_priority and no error/noop flag — the same silent-noop class filed in docs/issues/BUG-mo2-mcp-send_plugin_to-silent-noop-2026-07-05.md, and unlike _handle_mods_set_priority (lines 1045-1049) which returns PRIORITY_NOT_APPLIED.",
    "failure_scenario": "adopt_existing:true with wins_over resolved from a stale modlist.txt yielding an out-of-range priority -> refreshed_list.setPriority(...) returns False -> result {ok:true, priority:<unchanged>, requested_priority:N} -> mo2-create-mod.ts never reads result.priority back and logs '→ priority N' as if applied; the mod lands in the wrong precedence slot with a success response."
  },
  {
    "file": "tools/mo2-mcp/src/tools/mo2-create-mod.ts",
    "line": 108,
    "summary": "logApplyEvent unconditionally records `created \"<name>\" ... → priority <targetPri>` after an adopt_existing apply whose broker result is {created:false, adopted:true, priority:N}, so MO2's apply log misstates an adoption as a creation and reports the requested rather than actual priority.",
    "failure_scenario": "adopt_existing:true on an existing folder -> broker returns created:false/adopted:true -> _handle_system_log_apply (bridge lines 868-880) writes 'APPLY tool=mo2_create_mod ... created \"X\" wins_over=none → priority none' to MO2's log; an operator diagnosing a later problem reads that the tool created an empty mod when it actually registered pre-existing content. Only human-readable consumers today (mo2_audit_query/mo2_rollback read the TS AuditLogger), so operator diagnostics degrade rather than automated decisions."
  },
  {
    "file": "tools/mo2-control-plane/live-bridge/mo2_agent_control.py",
    "line": 1301,
    "summary": "adopt_existing registers whatever the stale folder contains as-is and the result reports nothing about that content (name/created/adopted/priority/absolute_path only), while the tool is still described as 'Create empty mod'; there is no supported path to obtain an empty mod at a name whose stale folder exists (MO2's own dialog offers Merge/Replace/Rename).",
    "failure_scenario": "Curator wants a clean empty 'PatchHub' but mods/PatchHub is a stale leftover with plugins and loose files; without adopt_existing -> refused; with it -> the folder's unknown assets are registered as the mod with no inventory in the response and no register_from_mod/plugin enumeration on this path (only mo2-install.ts:439 does that). Mitigated only by MO2 registering refreshed mods disabled; an agent that toggles it on without mo2_mod_info inspection imports unreviewed content."
  },
  {
    "file": "tools/mo2-control-plane/live-bridge/mo2_agent_control.py",
    "line": 1286,
    "summary": "The new 'folder exists on disk but unregistered' refusal reuses ErrorCode.INVALID_PARAMS — the same code as 'name already exists' and every type error — so the one recoverable condition this commit introduces (retry with adopt_existing) is distinguishable only by string-matching the message; nothing in tools/mo2-mcp/src handles invalid_params and mo2-create-mod.ts:93 discards the code entirely.",
    "failure_scenario": "An agent, the broker-error classifier, or a future auto-adopt path cannot branch on error.code; the ps1 harness itself asserts on `-match 'Mod Exists'` / `-match 'adopt_existing'` (lines 153-157), so a wording tweak silently breaks the test and any caller keyed on the text. Add a dedicated code (e.g. mod_dir_exists_unregistered) and carry existing_dir in error.details."
  },
  {
    "file": "tools/mo2-control-plane/live-bridge/mo2_agent_control.py",
    "line": 1295,
    "summary": "organizer.refresh() in the new adopt path is called bare inside _on_main_thread; if it raises, the pump re-raises (lines 246-247) into the handler's outer except which returns ErrorCode.MAIN_THREAD_UNAVAILABLE (lines 1352-1358) — the code otherwise reserved for a blocked pump — whereas _handle_mods_rename (lines 1135-1139) wraps refresh() in try/except for exactly this reason.",
    "failure_scenario": "refresh() raises (e.g. a mod folder with an unreadable meta.ini during model rebuild) -> client receives main_thread_unavailable with the refresh exception text and treats MO2 as hung rather than the adopt as failed. Pre-existing for the create path's refresh at line 1336 as well, so guarding both in one shared tail fixes it once; no repo evidence yet of refresh() raising in the field."
  },
  {
    "file": "tools/mo2-mcp/src/tools/mo2-create-mod.ts",
    "line": 76,
    "summary": "The plan's targets/affectedFiles list only modlist.txt for the adopt case too, but adopting via organizer.refresh() writes mods/<name>/meta.ini into a folder that had none and registers the mod; snapshot.ts (lines 66-72, 102-118) restores only listed sources, so a rollback of an adopt plan reverts the modlist line and leaves the new meta.ini and registration behind.",
    "failure_scenario": "adopt_existing:true on a hand-dropped folder without meta.ini -> MO2 refresh creates meta.ini -> mo2_rollback of this plan restores modlist.txt only -> the folder stays registered with the broker-written meta.ini. Pre-existing gap shared with the create path and mo2-create-separator (mo2-install.ts:300 by contrast lists destPath); adding join(modsDir, name) to affectedFiles lets the existing absent/directory snapshot logic cover both create and adopt."
  },
  {
    "file": "tools/mo2-control-plane/live-bridge/mo2_agent_control.py",
    "line": 1299,
    "summary": "The adopt branch's result/priority tail (lines 1300-1313) is a token-for-token copy of the create branch's (lines 1337-1349) apart from variable names and the created/adopted flags, it calls organizer.modList() twice back-to-back (lines 1296 and 1300) where the create branch reuses the pre-refresh handle, and the on-disk detection (lines 1275-1283) is inline in the closure rather than a helper the sibling createMod site at line 2245 could share.",
    "failure_scenario": "Two 12-line tails must now be edited in lockstep — the next priority-reporting fix (e.g. adding the PRIORITY_NOT_APPLIED check from _handle_mods_set_priority, item 9 above) lands in one branch and silently diverges in the other, and the inconsistent modList() re-fetch implies to readers that refresh() invalidates the IModList handle while the create branch contradicts it. Collapse both into one shared tail taking (mod, name, absolute_path, created, adopted) and lift the detection into _existing_unregistered_mod_dir(organizer, name)."
  }
]
```

File paths in the JSON were absolute (`C:/Users/Jamie/Documents/projects/bgs-modding-superpowers/...`) in the original output and are shown repo-relative here; `&lt;`/`&gt;` HTML entities in the original are rendered as `<`/`>`. No other edits were made.

## Appendix B — Local review measurements

```
# MCP tool-schema size (tools/list against each dist/index.js)
xedit-mcp:  init 223ms, 17 tools, 18978 bytes (~4745 tokens)
bgs-kb-mcp: init 229ms,  5 tools,  4002 bytes (~1001 tokens)
mo2-mcp:    init 212ms, 38 tools, 19616 bytes (~4904 tokens)

# PowerShell hop per xEdit call
bare `pwsh -NoProfile -Command 'exit 0'`                       187 ms
`xedit-client.ps1 automation call` (script load, bogus pid)    421 / 390 / 390 ms
`xedit-client.ps1 process wait` (readiness poll)               388 ms

# Session-start hook output
hooks/run-hook.cmd session-start (repo copy)                   0 bytes
hooks/run-hook.cmd session-start (installed cache copy)        0 bytes
same script with `set BOOTSTRAP` moved above the `if`          17,699 bytes

# Mirror drift (root vs plugins/bgs-modding-superpowers)
tools/xedit-mcp/dist: index.js, launch.js differ; mo2-ini.js missing in mirror
tools/mo2-mcp/dist/tools/mo2-create-mod.js differs
tools/mo2-control-plane/live-bridge/mo2_agent_control.py differs
.mcp.json differs by design (mirror uses ./tools/... relative paths)
```
