# Contributing to `bgs-modding-superpowers`

> **Harness status (2026-07-29):** The local prototype harness was destroyed by an unattributed operation and will not be rebuilt. All `.artifacts/mo2` paths and instructions below are **DEFUNCT**. Testing now uses externally-configured Starfield or Fallout 4 MO2 instances; machine-specific details and the forensic record are private.

Thanks for the interest. This doc is for contributors opening pull requests against this repo. End users should read [README.md](README.md) and [`.opencode/INSTALL.md`](.opencode/INSTALL.md) instead.

## Clone + bootstrap

```powershell
git clone https://github.com/BB-84C/bgs-modding-superpowers.git
cd bgs-modding-superpowers
# Build the xEdit MCP
cd tools/xedit-mcp
npm install
npm run build
cd ..\..
```

The repo carries a dedicated MO2 sandbox under `.artifacts/mo2/` (gitignored — bring your own for now). The development plan and roadmap live in `docs/internal/`.

### Dev sessions inside this repo don't use this repo's `.mcp.json`

The root [`.mcp.json`](.mcp.json) doubles as the plugin manifest — it uses
`${CLAUDE_PLUGIN_ROOT}`, which only resolves when the file is loaded *as a
plugin*. Claude Code also reads it as a project-scoped MCP config when you
open this directory as a project, where that variable is undefined; the
three servers then fail to start (`CONNECTION_CLOSED`). `.claude/settings.local.json`
lists `xedit`, `bgs_kb`, and `mo2` under `disabledMcpjsonServers` for exactly
this reason — install the plugin normally (see README.md) and use the
plugin-loaded copies of the servers while developing here. If you need to
exercise an unreleased `tools/` build from inside the repo, point a separate,
non-committed MCP config at the built `dist/index.js` files with explicit
paths instead of re-enabling the project-scoped entries.

## Branch conventions

- Work on feature branches: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`, `reshape/<topic>`.
- Target `main` via pull request. Do not push directly to `main` (especially do not force-push).
- Prefer multiple small commits per logical step over one large monolithic commit.
- For ambiguous or high-risk implementation work, prefer best-of-N candidate generation over single-shotting.

## Test commands

- `tools/xedit-mcp/` — `npm test` (vitest unit tests). Integration tests live in `tools/xedit-mcp/tests/integration/` and require a running MO2 + xEdit; gate diagnostic-only tests behind `BGS_MCP_DIAG=1`.
- `tests/` (top-level) — PowerShell tests for the MO2 control plane and VFS launcher. Run with `pwsh -File tests/<suite>/...`.

## Where things live

| Path | Purpose |
|---|---|
| `skills/` | Shippable agent skills (Superpowers convention). Each dir has a `SKILL.md` with YAML frontmatter. |
| `tools/xedit-mcp/` | TypeScript MCP server. Pre-built `dist/` is tracked; `prepare` rebuilds on install. |
| `tools/mo2-vfs-launcher/` | PowerShell outer client for the xEdit MCP. Runtime dependency. |
| `tools/mo2-control-plane/` | C++ MO2 plugin DLL source, Python loader, broker. |
| `tools/xedit-hook-bridge/dist/` | Retired Delphi DLL retained for history only; do not deploy or rebuild it. Native `xEdit.exe -automation-serve` is canonical. |
| `.claude-plugin/`, `.codex-plugin/`, `.opencode/plugins/` | Per-harness manifests + OpenCode plugin wiring. All four manifests share `.mcp.json` for the MCP declaration. |
| `hooks/` | Claude Code / Codex session-start hook chain. |
| `scripts/` | Version bumping + (P6+) installer scripts. |
| `docs/internal/` | Roadmap, plans, design specs, hook + MCP specs, future-skills design notes. |
| `tests/`, `.artifacts/` | Dev-only verification scaffolding (gitignored as appropriate). |

## Pull request expectations

- Reference the issue or design doc the PR implements. Plans live under `docs/internal/superpowers/plans/`.
- Run the relevant test suite locally and report what passed.
- If the change touches shippable surfaces (skills, MCP, manifests, scripts), confirm it still installs cleanly into a fresh OpenCode profile against the dev MO2 sandbox.
- Don't commit `node_modules/`, `.artifacts/` content, or other gitignored material.

## Local hooks (plugins/ mirror freshness)

`plugins/bgs-modding-superpowers/` is a tracked, generated mirror of `tools/`,
`skills/`, `hooks/`, and `knowledge/` (built by
`scripts/build-portable-plugin.ps1`). Nothing on GitHub enforces that a
commit touching those source trees also regenerates the mirror — this repo
has no CI — so it is easy to land source changes and forget the mirror, the
way `plugins/` drifted four commits stale before the 2026-09-14 inherited-
project review (see `docs/internal/reviews/2026-09-14-inherited-project-review.md`,
findings L1/U5).

`scripts/check-plugin-mirror-freshness.ps1` checks for exactly that: it finds
the most recent commit that touched `plugins/`, then fails if any later
commit touched `tools/`, `skills/`, `hooks/`, or `knowledge/` without a
follow-up mirror commit. It's wired up as a tracked pre-push hook at
`.githooks/pre-push`, but git does not use that path unless you opt in once
per clone:

```powershell
git config core.hooksPath .githooks
```

This is a local, opt-in gate, not enforced server-side — `git push
--no-verify`, a clone that never ran the command above, or a PR opened
without pushing through this checkout all skip it. Run the check manually at
any time with:

```powershell
pwsh -NoProfile -File scripts/check-plugin-mirror-freshness.ps1
```

If it reports drift, regenerate the mirror before pushing:

```powershell
pwsh -NoProfile -File scripts/build-portable-plugin.ps1 -OutputDir plugins -Force
```

## Version bumping

Versions across `package.json`, `.claude-plugin/{plugin,marketplace}.json`, and `.codex-plugin/plugin.json` are kept in lockstep by `scripts/bump-version.sh` driven by `.version-bump.json`:

```powershell
bash scripts/bump-version.sh 0.2.0
```

(Requires `jq` available on PATH.)

## Code of conduct

Be civil. Don't ship code that you wouldn't be comfortable explaining to another maintainer in person.

## License

By contributing, you agree your contributions are licensed under the MIT license. See [LICENSE](LICENSE).
