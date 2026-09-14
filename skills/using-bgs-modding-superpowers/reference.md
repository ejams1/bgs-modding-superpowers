# Reference: skills, MCP tools, and routing detail

This is the full reference content for `using-bgs-modding-superpowers`, moved
out of the auto-injected `SKILL.md` because it is either (a) already visible
to the agent as tool schemas / the harness's own skill listing, or (b) detail
only needed when actually invoking a specific skill or tool. Read this file
on demand — it is not injected every session.

## Skill trigger phrases

| Skill | Auto-triggers when |
|---|---|
| `setting-up-bgs-modding-environment` | First conversation in a project; MO2 or xEdit not yet detected; user says "set up", "install", "bootstrap", "configure" |
| `maintaining-modding-environments` | After first-run: "ongoing", "maintain", "register custom pack", "prune cache", "update knowledge base", "modding environment health check" |
| `evaluating-bgs-mods` | Deciding whether a mod belongs in the pack; "should I add this mod", "is this mod good", "评估这个mod", "这个mod值得装吗", "this mod looks too good to be true" |
| `interpreting-mod-author-instructions` | After INCLUDE verdict, before download/install; "how do I install", "FOMOD choices", "which file to download", "author说明", "which variant", "按作者说明安装" |
| `curating-bgs-modpack` | Whole-pack incremental build strategy; "plan the pack", "batch strategy", "rollback point", "naming convention", "declare 风格", "策展整合包", "整合包规划" |
| `diagnosing-bgs-problems` | It broke — symptom-first triage; "CTD", "crash log", "FPS drop", "stuttering", "Buffout", "freeze", "won't start", "崩溃", "掉帧", "卡顿" |
| `testing-bgs-modpack` | Proactive post-install verification of a batch; "test the pack", "verification", "post-install check", "is it stable", "what should I test", "测试整合包", "验证安装" |
| `xedit-automation` | Any task involving `.esp/.esm/.esl` plugin files, FormIDs, masters, conflicts, ESL flagging, ITM/UDR cleaning, Pascal scripts |
| `xedit-conflict-audit` | "Why is this override not winning?", "Which plugins overlap on this record?", "Is this load order safe?" |
| `writing-bgs-load-order` | Reading/editing/generating `plugins.txt` or `loadorder.txt`; enabling/disabling/reordering/adding/removing plugins; launching xEdit with a custom plugins file; "load order", "enable this plugin", "disable that plugin", "what does the asterisk mean" |
| `using-bgs-translator` | Translate a Bethesda plugin's text to another language; "translate this mod", "汉化这个 mod", "localize mod to chinese", "build SST for", "use my LLM to translate plugins" |
| `using-bgs-archive` | unpack/pack BA2/BSA archives; inspect archive format/contents; extract assets |
| `using-bgs-papyrus` | compile/decompile Papyrus PSC<->PEX for Skyrim/FO4/Starfield |
| `writing-modpack-devlog` | "Log this", "record what I did", "note this change", "add to dev-log", "track this decision" |
| `writing-modpack-changelog` | "Cut a release", "release notes", "what changed since v1.2", "prepare release for Nexus" |

## MCP tool catalogue

The bundled `xedit` MCP server is fully **non-blocking**: every tool returns
immediately. The xEdit daemon's lifecycle is tracked in the server's
in-memory state machine, and domain tools fast-fail with `code: "not_ready"`
if you call them before the daemon is ready. (Full parameter schemas are
already visible to you as tool definitions; this table is a quick index of
intent, not a schema reference.)

### Lifecycle / health tools

| Tool | Use |
|---|---|
| `xedit_status` | Pure read. Returns `{ status: "not_started" \| "starting" \| "ready" \| "failed", ... }`. Never modifies state. Use this to POLL while waiting for a launch. |
| `xedit_start` | Kicks off an asynchronous daemon launch if not already starting/ready. Returns immediately. Accepts optional overrides: `{ launcherPath?, gameMode?, dataPath?, pluginsFile?, moProfile? }`. Use `dataPath` (MO2 `gamePath + "\\Data"`) to override xEdit's registry-discovered platform path; use `pluginsFile` to point at a custom load order (see `writing-bgs-load-order`). The launch itself takes 60-240s; that work happens in the background. |
| `xedit_health` | When ready: sends `system.ping` through the named pipe to catch zombies. After a flush exit timeout, rechecks the retained managed PID so a delayed normal exit can clear lifecycle state without force. |
| `xedit_dirty` | Returns xEdit dirty state plus authoritative contract-0.23 pending-rename readback when available, with a local fail-closed fallback for older daemons. Pending saves remain visible even when daemon dirty state is false. |
| `xedit_flush` | Contract-0.23 durability boundary. Requires consent, drains pending renames, validates the response, waits for the managed daemon's promised self-exit, and reports complete, partial, or unknown outcome. Failed in-band renames get one final exit-time retry; fresh-daemon readback decides durability. |
| `xedit_stop` | Stops the daemon and clears MCP runtime state. It refuses unsaved edits or pending-shutdown saves unless `force: true` is explicitly chosen; forced abandonment is reported and audited. |
| `xedit_restart` | Stops the daemon with the same dirty/pending-save safety, then kicks off a fresh async launch. Use only when no pending save is tracked; `force: true` is explicit abandonment, not a flush. |

### Domain tools (6) — require ready, fast-fail otherwise

| Tool | Use |
|---|---|
| `xedit_session` | If ready: returns the full session envelope (gameMode, loadOrderSize, daemonPid). If not_started: auto-initiates the launch. Otherwise: returns the current status. Always non-blocking. |
| `xedit_list_capabilities` | Curated 50-command contract-0.23 digest + live drift report. |
| `xedit_find_record` | Locate by `{file, formId}` or `{editorId}`. |
| `xedit_read_record` | Fields + base record + winning override. |
| `xedit_inspect_conflicts` | W2 verdict tool: `no_conflict / itpo / itm / minor / breaking`. |
| `xedit_call(command, args)` | Atomic passthrough for native daemon commands; in-harness. Lifecycle-owned `session.flush` is refused here and must use `xedit_flush`. |

The structured daemon-command and workflow reference now lives in KB records.
Use `bgs_kb_query` / `bgs_kb_get` for deep reference retrieval; the old
`skills/xedit-automation/xedit-knowledgebase.md` path is a redirect only.

### BGS knowledge-base tools (3) — curated knowledge, no xEdit daemon

The sibling BGS knowledge-base MCP is for curated modding knowledge, not live
runtime state. It works before MO2 / xEdit are configured; use xEdit MCP for
actual plugin, load-order, and record readback.

| Tool | Use |
|---|---|
| `bgs_kb_status` | Reports loaded KB packs, versions, games, domains, cache root, and user pack roots. |
| `bgs_kb_query` | Searches loaded packs for ranked knowledge snippets with game/domain filters and sources. |
| `bgs_kb_get` | Fetches a full record by id, merging game-specific variants when `game` is provided. |

## Routing notes

- When the user asks about "what can you do", reference the skills inventory
  above; do not invent capabilities the plugin does not have.
- When answering BGS modding-domain questions, prefer local KB retrieval before
  web search. The bundled core pack ships inline; per-game packs may be
  installed later via setup / maintenance skills; end-user packs may be
  registered via `$BGS_KB_USER_PACKS` through `maintaining-modding-environments`.
- When the user is deciding whether to add or keep a mod ("should I install X",
  "is this good", "评估"), route to `evaluating-bgs-mods` BEFORE any
  install/download action.
- When an INCLUDE verdict is in and the user needs to read author instructions /
  pick FOMOD options / choose a file or variant, route to
  `interpreting-mod-author-instructions`.
- When the user is planning the whole pack, sizing batches, deciding rollback
  boundaries, or declaring 风格, route to `curating-bgs-modpack`.
- When the user reports a crash, CTD, FPS drop, freeze, or stutter ("崩溃",
  "掉帧", "卡顿"), route to `diagnosing-bgs-problems` for symptom-first triage
  BEFORE any blame attribution.
- When the user wants to verify a freshly installed batch ("test the pack",
  "is it stable", "验证安装"), route to `testing-bgs-modpack`.
- When the user wants to translate plugin text or emit SST dictionaries for a
  mod, route to `using-bgs-translator` instead of xEdit; translator reads plugin
  text and emits dictionaries, it does not modify plugin binaries.
- When the user wants to inspect, unpack, extract, or pack BA2/BSA archives,
  route to `using-bgs-archive`; archive packing must write to MO2 overlays, not
  game `Data` or Stock-Game trees.
- When the user wants to compile or decompile Papyrus scripts (`.psc` / `.pex`),
  route to `using-bgs-papyrus`; compiled `.pex` output must go to MO2 overlays,
  not game `Data` or Stock-Game trees.
- When the user asks to "log", "record", "track", or "note" modpack work,
  route to `writing-modpack-devlog`. When the user asks to "cut a release" or
  prepare release notes, route to `writing-modpack-changelog`.

## See also

- `setting-up-bgs-modding-environment` — first-run setup orchestrator.
- `maintaining-modding-environments` — ongoing environment care, KB updates,
  custom-pack registration, cache pruning, and health checks after first-run.
- `evaluating-bgs-mods` — judgment skill: should this mod go in the pack (BGS
  systemic-design fit, quality/risk/pack-value); hands off to
  `interpreting-mod-author-instructions` on INCLUDE.
- `interpreting-mod-author-instructions` — judgment skill: how to correctly
  download/install per author说明 (FOMOD reasoning, file/variant selection,
  prerequisites). Downstream from `evaluating-bgs-mods` INCLUDE verdict.
- `curating-bgs-modpack` — judgment skill: whole-pack incremental strategy
  (batch sizing, rollback boundaries, attribution/naming, declaring 风格);
  cross-stage skill that the per-mod skills feed.
- `diagnosing-bgs-problems` — judgment skill: symptom-first triage for CTD /
  FPS / freeze / stutter; escalates to `xedit-conflict-audit` or
  `using-bgs-archive` once root-cause class is identified.
- `testing-bgs-modpack` — judgment skill: proactive post-install verification
  of an install batch; escalates to `diagnosing-bgs-problems` on failure.
- `xedit-automation` — hub skill for all xEdit work; routing doctrine,
  anti-patterns, sub-agent recipes.
- BGS KB records under `knowledge/bgs-kb/packs/core/records/` — deep reference
  for daemon commands, error codes, save semantics, glossary, and durable gotchas.
- `xedit-conflict-audit` — the W2 conflict-audit workflow.
- `using-bgs-translator` — CLI + Tk workflow for LLM-assisted plugin text
  translation and SST dictionary export.
- `using-bgs-archive` — BA2/BSA archive inspection, extraction, and safe
  overlay-only packing.
- `using-bgs-papyrus` — Papyrus PSC/PEX compile/decompile workflows for Skyrim,
  Fallout 4, and Starfield.
- `writing-modpack-devlog`, `writing-modpack-changelog` — runtime asset
  skills for project documentation.
