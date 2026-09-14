---
name: using-bgs-modding-superpowers
description: "Use when starting ANY conversation involving Bethesda Game Studio modding, MO2, xEdit, or modpack curation. Bootstrap that loads the toolkit overview, lists available task skills, and enforces the hard rules of this plugin. Auto-injected by the OpenCode plugin's chat.messages.transform hook and by the hooks/ session-start chain in Claude Code and Codex."
---

<EXTREMELY_IMPORTANT_BGS_MODDING_SUPERPOWERS>
This is the bgs-modding-superpowers per-session bootstrap. If you are reading this,
the plugin injected it into the first user message of this session. Do NOT discard
it. Do NOT respond to the user yet without first checking whether one of the task
skills below applies.
</EXTREMELY_IMPORTANT_BGS_MODDING_SUPERPOWERS>

# Using BGS Modding Superpowers

You are operating with the `bgs-modding-superpowers` plugin loaded: an
agent-driven toolkit for Bethesda Game Studio modpack curation (MO2 control
plane, xEdit MCP, conflict-audit workflow, dev-log / release-changelog
skills). Tool parameter schemas and each skill's trigger description are
already visible to you elsewhere in context — this file does not repeat them.
For the full skill-trigger table, the MCP tool catalogue, and routing detail,
read `reference.md` in this skill's directory.

## Skills available

`setting-up-bgs-modding-environment` · `maintaining-modding-environments` ·
`evaluating-bgs-mods` · `interpreting-mod-author-instructions` ·
`curating-bgs-modpack` · `diagnosing-bgs-problems` · `testing-bgs-modpack` ·
`xedit-automation` · `xedit-conflict-audit` · `writing-bgs-load-order` ·
`using-bgs-translator` · `using-bgs-archive` · `using-bgs-papyrus` ·
`writing-modpack-devlog` · `writing-modpack-changelog`

When the user's intent matches one of these, invoke it through your skill
tool BEFORE replying. Do not paraphrase a skill from memory; let it load.

## Canonical xEdit lifecycle (do this every session that touches xEdit)

```
1. xedit_start({})                  -> { status: "starting" }      (or "ready")
2. xedit_status({})                 -> poll until status="ready"   (sleep 5-15s between calls)
3. xedit_health({})                 -> confirm responsive=true
4. xedit_session({}) / xedit_*      -> normal domain work
5. xedit_dirty({})                  -> check dirty state and pendingShutdownSave
6. xedit_flush({})                  -> when pending > 0, drain + confirm daemon self-exit
7. xedit_start({ ... })             -> fresh daemon for persistence readback after flush
8. xedit_stop({}) / restart({ ... }) -> only when no dirty or pending state exists
```

NEVER call a domain tool in a tight loop expecting it to "wait." If
`xedit_status` reports `status: "failed"`, surface `data.error` to the user and
stop — common causes are MO2 not running visibly, the Python plugin not loaded,
the xEdit binary missing, or xEdit's automation-serve tripping on the active
load order.

## Hard rules (non-negotiable)

1. **The user's `<MO2_Root>` and any `<MO2_Root>/<game>/Data/` (or equivalent
   "Stock Game" tree) is real game state.** Never write into it directly. Any
   game-local change is expressed as an MO2 mod overlay under
   `<MO2_Root>/mods/<mod-name>/`. The MO2 VFS projects it at runtime.
2. **All xEdit work goes through the bundled `xedit` MCP.** Never spawn
   `xEdit.exe` directly from the shell, never parse `.esp/.esm/.esl` files with
   your own Python/JS, never invoke `xedit-client.ps1` from raw shell. The MCP
   exists so the harness can enforce validation, state, rules, and audit on
   every call. Atomic passthrough (`xedit_call`) is the documented escape hatch
   when an intent tool does not fit — it is still in-harness.
3. **Mutating operations require explicit user consent and a daemon launched
   with `-IKnowWhatImDoing`.** Read the `xedit-automation` skill BEFORE any
   destructive work. The anti-pattern list there is binding.
4. **A `session.save` response is not durability.** A nonzero
   `savedFilesPendingShutdown` / `savePendingShutdownCount` is deferred. On
   contract 0.23, `xedit_dirty` reconciles that fallback with the daemon's
   authoritative pending queue and `xedit_flush` is the only supported in-band
   drain. It validates the response and confirms daemon self-exit before clearing
   the blocking guard. A partial or unknown outcome remains visible as
   `lastFlush`; after relaunch it is labelled `previousSessionFlush` with the old
   PID and timestamp. Failed in-band renames receive one normal exit-time retry,
   so fresh-daemon readback, not the partial envelope alone, decides durability.
   `force:true` on stop/restart is still explicit abandonment, never durability proof.
5. **Large scope (many records, broad conflict survey) → delegate to a
   read-only investigator subagent FIRST.** The subagent burns its own context
   and returns a distilled summary. Do not loop hundreds of records through
   your own context.
6. **BGS domain knowledge routes through the KB first.** For questions about
   how BGS modding works — Papyrus semantics, plugin-format gotchas, archive
   precedence, load-order conventions, common engine quirks, or game-specific
   toolchain gotchas — call `bgs_kb_status` / `bgs_kb_query` before
   improvising or reaching for web search. If the question is about what the
   current local load order, plugin, or record actually is, use `xedit_*` or the
   relevant file/CLI surface instead. The KB is advisory; xEdit readback remains
   authoritative for actual state. If `bgs_kb_status` reports no packs or the
   needed game pack is missing, fall back to web research using the roadmap
   Appendix source list or route setup/maintenance work to install the pack.
7. **First-run state**: if MO2 / xEdit / the control-plane Python plugin are
   not yet set up on this machine, invoke `setting-up-bgs-modding-environment`
   BEFORE any modpack work. That skill orchestrates detection and install.
8. **Nexus credentials and Premium download paths**: MO2 stores the user's
   Nexus API key globally in Windows Credential Manager under target
   `ModOrganizer2_APIKEY` (legacy) / `ModOrganizer2_NEXUS_OAUTH_TOKENS`
   (modern OAuth). Reading the key requires explicit per-session user consent
   and the key must be masked in any visible output. The agent-friendly
   refresh path for Nexus update state is "Option B" — direct API call to
   `/v1/games/{game}/mods/{id}.json` + write back to `meta.ini` via
   `mo2_edit_meta`, no MO2 GUI launch needed. Both workflows are documented in
   the `maintaining-modding-environments` skill and in KB records
   `install-planning.mo2-windows-credential-mining.v1` +
   `install-planning.nexus-direct-api-update-check.v1`. For Premium-account
   direct downloads, use `POST /v1/games/{game}/mods/{id}/files/{file_id}/download_link.json`
   (returns 7 CDN mirrors) — Premium-only; free accounts must use the Nexus
   browser flow.

---

> Plugin: `bgs-modding-superpowers`. Repo: https://github.com/BB-84C/bgs-modding-superpowers.
> If any environmental component (MO2, xEdit, control-plane Python plugin) is missing,
> route through `setting-up-bgs-modding-environment` before continuing.
> Full skill-trigger table, MCP tool catalogue, and routing notes: `reference.md`.
