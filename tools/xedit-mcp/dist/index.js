import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { statSync } from "node:fs";
import { createAuditLogger } from "./audit.js";
import { defaultRegistry } from "./rules/registry.js";
import { xeditSessionTool } from "./tools/session.js";
import { xeditListCapabilitiesTool } from "./tools/list-capabilities.js";
import { makeFindRecordHandler } from "./tools/find-record.js";
import { makeReadRecordHandler } from "./tools/read-record.js";
import { makeInspectConflictsHandler } from "./tools/inspect-conflicts.js";
import { makeInspectConflictsDeepHandler } from "./tools/inspect-conflicts-deep.js";
import { makeFindRecordsByPatternHandler } from "./tools/find-records-by-pattern.js";
import { makeCreateChildRecordHandler } from "./tools/create-child-record.js";
import { makeNavigateAncestryHandler } from "./tools/navigate-ancestry.js";
import { makeCallHandler } from "./tools/call.js";
import { refuse } from "./envelope.js";
import { MCP_ERROR_CODES } from "./types.js";
import { launchDaemon } from "./launch.js";
import { resolveMo2DataPath } from "./mo2-ini.js";
import { PendingSaveTracker, dirtyFileNames, pendingSaveLifecycleRisk, refreshPendingSaveAuthority, withPendingShutdownSave, } from "./pending-save.js";
import { hashArgs } from "./audit-line.js";
import { makeFlushHandler, retryFailedFlushExit } from "./flush.js";
import { dirtyProbeLifecycleDecision, launchKickoffDecision, lifecycleNotReadyHint, } from "./lifecycle-decisions.js";
export function buildServerToolset(opts) {
    const audit = opts.audit ?? createAuditLogger({
        baseDir: opts.auditDir ?? join(tmpdir(), "xedit-mcp-audit"),
    });
    const registry = defaultRegistry();
    const session = xeditSessionTool({
        adapter: opts.adapter,
        sessionId: opts.sessionId,
        daemonPid: opts.daemonPid ?? process.pid,
        mcpModeActive: opts.mcpModeActive,
        audit,
        onDirtyStateReadback: (result) => opts.pendingSaveTracker?.observeDirtyState(result),
    });
    const getCtx = session.getContext;
    const listCaps = xeditListCapabilitiesTool({ adapter: opts.adapter, getContext: getCtx, audit });
    const find = makeFindRecordHandler({ adapter: opts.adapter, registry, audit, getContext: getCtx });
    const read = makeReadRecordHandler({ adapter: opts.adapter, registry, audit, getContext: getCtx });
    const inspect = makeInspectConflictsHandler({ adapter: opts.adapter, registry, audit, getContext: getCtx });
    const inspectDeep = makeInspectConflictsDeepHandler({ adapter: opts.adapter, registry, audit, getContext: getCtx });
    const findByPattern = makeFindRecordsByPatternHandler({ adapter: opts.adapter, registry, audit, getContext: getCtx });
    const createChild = makeCreateChildRecordHandler({ adapter: opts.adapter, registry, audit, getContext: getCtx });
    const navigateAncestry = makeNavigateAncestryHandler({ adapter: opts.adapter, registry, audit, getContext: getCtx });
    const call = makeCallHandler({
        adapter: opts.adapter,
        registry,
        audit,
        getContext: getCtx,
        onSuccessfulSessionSave: (result) => opts.pendingSaveTracker?.observeSuccessfulSave(result),
    });
    // xedit_flush is intentionally absent: it is owned by the stdio lifecycle
    // controller because managed-process exit cannot be handled by this toolset.
    const handlers = {
        xedit_session: session.tool,
        xedit_list_capabilities: listCaps,
        xedit_find_record: find,
        xedit_read_record: read,
        xedit_inspect_conflicts: inspect,
        xedit_inspect_conflicts_deep: inspectDeep,
        xedit_find_records_by_pattern: findByPattern,
        xedit_create_child_record: createChild,
        xedit_navigate_ancestry: navigateAncestry,
        xedit_call: call,
    };
    return {
        list: () => Object.keys(handlers),
        invoke: async (name, args) => {
            const h = handlers[name];
            if (!h) {
                return refuse({
                    tool: name,
                    summary: `Unknown tool: ${name}`,
                    code: MCP_ERROR_CODES.INVALID_REQUEST,
                    hint: "List available tools via the MCP listTools request.",
                });
            }
            return h(args);
        },
    };
}
function resolveLaunchOpts(overrides = {}) {
    const envClient = process.env.BGS_XEDIT_CLIENT_SCRIPT;
    const envLauncher = process.env.BGS_XEDIT_LAUNCHER_PATH;
    const envGameMode = process.env.BGS_XEDIT_GAME_MODE;
    const envProfile = process.env.BGS_MO2_PROFILE ?? "Default";
    const envDataPath = process.env.BGS_XEDIT_DATA_PATH;
    const envPluginsFile = process.env.BGS_XEDIT_PLUGINS_FILE;
    const envMoRoot = process.env.BGS_MO2_ROOT;
    // Resolution priority: explicit overrides (from xedit_start args) > env vars > auto-detect.
    const moRoot = overrides.moRoot ?? envMoRoot;
    const gameMode = overrides.gameMode ?? envGameMode;
    const moProfile = overrides.moProfile ?? envProfile;
    const dataPath = overrides.dataPath ?? envDataPath;
    const pluginsFile = overrides.pluginsFile ?? envPluginsFile;
    // Consent is per-launch and explicit only. No env-var fallback by design:
    // the dev workflow must opt into mutations via the MCP tool arg so the
    // audit log captures the consent decision at the call site.
    const iKnowWhatImDoing = overrides.iKnowWhatImDoing === true ? true : undefined;
    const starfieldRedPill = overrides.starfieldRedPill === false ? false : undefined;
    // launcherPath default: explicit override > env > <moRoot>/tools/xEdit/xEdit.exe
    const launcherPath = overrides.launcherPath
        ?? envLauncher
        ?? (moRoot ? resolve(moRoot, "tools/xEdit/xEdit.exe") : undefined);
    if (envClient && launcherPath && gameMode) {
        return {
            clientScript: envClient,
            launcherPath,
            gameMode,
            moProfile,
            moRoot,
            // Default -D: to MO2's own gamePath\Data. Without it xEdit uses the
            // registry-discovered (raw Steam) install, which the VFS never covers,
            // and silently loads only the 16-ish vanilla files.
            dataPath: dataPath ?? resolveMo2DataPath(moRoot),
            pluginsFile,
            iKnowWhatImDoing,
            starfieldRedPill,
        };
    }
    try {
        const thisFile = fileURLToPath(import.meta.url);
        const pluginRoot = resolve(dirname(thisFile), "..", "..", "..");
        const candidateClient = envClient ?? resolve(pluginRoot, "tools/mo2-vfs-launcher/xedit-client.ps1");
        // Dev-sandbox fallback: only honored when the .artifacts/mo2 tree actually
        // exists. End-user clones don't have it, so this branch fails cleanly into
        // the configuration error below.
        const devSandboxLauncher = resolve(pluginRoot, ".artifacts/mo2/tools/xEdit/xEdit.exe");
        const devSandboxMoRoot = resolve(pluginRoot, ".artifacts/mo2");
        const candidateLauncher = launcherPath ?? devSandboxLauncher;
        const candidateMoRoot = moRoot ?? devSandboxMoRoot;
        statSync(candidateClient);
        statSync(candidateLauncher);
        return {
            clientScript: candidateClient,
            launcherPath: candidateLauncher,
            gameMode: gameMode ?? "Fallout4",
            moProfile,
            moRoot: candidateMoRoot,
            dataPath: dataPath ?? resolveMo2DataPath(candidateMoRoot),
            pluginsFile,
            iKnowWhatImDoing,
            starfieldRedPill,
        };
    }
    catch {
        return {
            error: "xedit-mcp is not configured. The harness MCP server entry needs at minimum: " +
                "BGS_MO2_ROOT (absolute path to the user's MO2 install root, i.e. the directory " +
                "containing ModOrganizer.exe). With BGS_MO2_ROOT set, the xEdit launcher defaults " +
                "to <BGS_MO2_ROOT>/tools/xEdit/xEdit.exe. " +
                "Optional env vars: BGS_XEDIT_CLIENT_SCRIPT (path to xedit-client.ps1; auto-detected " +
                "next to this MCP), BGS_XEDIT_LAUNCHER_PATH (override the xEdit.exe location), " +
                "BGS_XEDIT_GAME_MODE (e.g. 'Fallout4'), BGS_MO2_PROFILE (default 'Default'), " +
                "BGS_XEDIT_DATA_PATH (-D: flag, MO2 Data dir), BGS_XEDIT_PLUGINS_FILE (-P: flag). " +
                "Or pass these as xedit_start({ moRoot, launcherPath, gameMode, dataPath, pluginsFile, moProfile, starfieldRedPill }) " +
                "overrides at runtime.",
        };
    }
}
// IMPORTANT: every parameterized tool MUST declare its `properties` and (where the
// handler enforces them) `required` explicitly. OpenCode's tool-routing layer
// inspects this JSON Schema to decide whether to forward args at all; a tool
// whose schema lacks `properties` receives `{}` on every call regardless of what
// the user/model wrote. See bgs-kb-mcp commit 15adaa7 for the parallel fix that
// landed this rule on the sibling KB MCP. Keep these schemas in sync with the
// Zod schemas in `src/tools/*.ts`. Tools with no inputs use the explicit empty
// `properties: {}` form so the schema is still introspectable.
const FORM_ID_PATTERN = "^(0x)?[0-9a-fA-F]{1,8}$";
// Full behavior notes (defaults, side effects, recovery) for these fields
// live in skills/xedit-automation/SKILL.md ("Launching xEdit with explicit
// args", "Starfield save unlock", "Enabling consent") rather than here.
const LAUNCH_OVERRIDE_PROPERTIES = {
    moRoot: {
        type: "string",
        description: "MO2 install root. Defaults to $env:BGS_MO2_ROOT.",
    },
    launcherPath: {
        type: "string",
        description: "xEdit.exe path. Overrides the default <moRoot>/tools/xEdit/xEdit.exe.",
    },
    gameMode: {
        type: "string",
        description: "xEdit game mode, e.g. 'Fallout4', 'SkyrimSE'.",
    },
    dataPath: {
        type: "string",
        description: "-D flag: game Data directory. Defaults to MO2's gamePath\\Data.",
    },
    pluginsFile: {
        type: "string",
        description: "-P flag: custom plugins.txt path. Defaults to the active profile's.",
    },
    moProfile: {
        type: "string",
        description: "MO2 profile name. Defaults to $env:BGS_MO2_PROFILE or 'Default'.",
    },
    iKnowWhatImDoing: {
        type: "boolean",
        description: "Enables -IKnowWhatImDoing for mutating commands. Default false.",
    },
    starfieldRedPill: {
        type: "boolean",
        description: "Starfield only: adds the save-unlock switch trio. Default true.",
    },
};
export const TOOL_DEFINITIONS = [
    {
        name: "xedit_status",
        description: "Returns the daemon's lifecycle state without blocking: not_started, starting, ready, or failed.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "xedit_start",
        description: "Starts an asynchronous xEdit daemon launch; returns immediately with the current status.",
        inputSchema: {
            type: "object",
            properties: { ...LAUNCH_OVERRIDE_PROPERTIES },
            additionalProperties: false,
        },
    },
    {
        name: "xedit_health",
        description: "Pings the ready daemon to confirm it is still responsive (catches zombie daemons); otherwise same as xedit_status.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "xedit_dirty",
        description: "Returns xEdit's dirty and pending-shutdown-save state without blocking; see xedit-automation skill for the fail-closed fallback rules.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "xedit_flush",
        description: "Drains pending shutdown-save renames and waits for the daemon to exit, then clears lifecycle state.",
        inputSchema: {
            type: "object",
            properties: {
                force: {
                    type: "boolean",
                    description: "Forwarded unchanged to session.flush. Default false.",
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: "xedit_stop",
        description: "Stops the xEdit daemon and clears MCP state; refuses if unsaved/pending unless force=true.",
        inputSchema: {
            type: "object",
            properties: {
                force: {
                    type: "boolean",
                    description: "If true, stop despite unsaved/pending-shutdown state (explicit, audited abandonment). Default false.",
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: "xedit_restart",
        description: "Stops the daemon (same safety as xedit_stop); starts a fresh async launch.",
        inputSchema: {
            type: "object",
            properties: {
                ...LAUNCH_OVERRIDE_PROPERTIES,
                force: {
                    type: "boolean",
                    description: "If true, restart despite unsaved/pending state (audited). Default false.",
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: "xedit_session",
        description: "Non-blocking: returns session info when ready, auto-starts the daemon if not_started, else current status.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "xedit_list_capabilities",
        description: "Returns the curated command digest plus a live drift report against the daemon.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "xedit_find_record",
        // NOTE: top-level oneOf/anyOf/allOf/enum/not is forbidden by OpenAI-style
        // strict tool-schema backends; the handler-side Zod branch validation in
        // src/tools/find-record.ts is the real gate that rejects empty placeholders
        // and routes the call into the correct mode. minLength:1 on file and
        // editorId is allowed and still rejects empty-string placeholders at the
        // schema layer for clients that DO enforce that check. Tie-break rule
        // when both modes are supplied (file,formId wins) is documented in
        // skills/xedit-automation/SKILL.md rather than repeated in every field.
        description: "Finds a record by {file, formId} OR {editorId, signature?}. Pass exactly one mode; omit the other entirely.",
        inputSchema: {
            type: "object",
            properties: {
                file: {
                    type: "string",
                    minLength: 1,
                    description: "Plugin filename for {file, formId} mode. Omit in editorId mode.",
                },
                formId: {
                    type: "string",
                    pattern: FORM_ID_PATTERN,
                    description: "FormID hex, with/without 0x prefix, for {file, formId} mode. Omit in editorId mode.",
                },
                editorId: {
                    type: "string",
                    minLength: 1,
                    description: "EditorID for {editorId} mode. Omit in {file, formId} mode.",
                },
                signature: {
                    type: "string",
                    description: "Optional 4-char record signature filter, used only in editorId mode.",
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: "xedit_read_record",
        description: "Composite read of a record: full record, winning override, base record, and conflict status.",
        inputSchema: {
            type: "object",
            properties: {
                file: {
                    type: "string",
                    description: "Plugin filename including extension, e.g. 'kinggathcreations_spaceship.esm'.",
                },
                formId: {
                    type: "string",
                    pattern: FORM_ID_PATTERN,
                    description: "FormID as hex, with or without 0x prefix, e.g. '0000003C' or '0x0000003C'. Up to 8 hex digits.",
                },
            },
            required: ["file", "formId"],
            additionalProperties: false,
        },
    },
    {
        name: "xedit_inspect_conflicts",
        description: "Conflict-audit verdict (no_conflict/itpo/itm/minor/breaking) plus winning override and referenced_by listing.",
        inputSchema: {
            type: "object",
            properties: {
                file: {
                    type: "string",
                    description: "Plugin filename including extension, e.g. 'kinggathcreations_spaceship.esm'.",
                },
                formId: {
                    type: "string",
                    pattern: FORM_ID_PATTERN,
                    description: "FormID as hex, with or without 0x prefix, e.g. '0000003C' or '0x0000003C'. Up to 8 hex digits.",
                },
            },
            required: ["file", "formId"],
            additionalProperties: false,
        },
    },
    {
        name: "xedit_inspect_conflicts_deep",
        // r6 support-key/contract details for the child-group block and the
        // chained recursive-references call are in skills/xedit-automation
        // SKILL.md's r6 capability table.
        description: "Like xedit_inspect_conflicts, plus the r6 child-group conflict block and, if includeReferences=true, the recursive reference tree.",
        inputSchema: {
            type: "object",
            properties: {
                file: {
                    type: "string",
                    minLength: 1,
                    description: "Plugin filename including extension, e.g. 'kinggathcreations_spaceship.esm'.",
                },
                formId: {
                    type: "string",
                    pattern: FORM_ID_PATTERN,
                    description: "FormID as hex, with or without 0x prefix, e.g. '0000003C' or '0x0000003C'. Up to 8 hex digits.",
                },
                includeReferences: {
                    type: "boolean",
                    description: "If true, also call records.references {recursive:true} and attach the result under data.references. Default false.",
                },
            },
            required: ["file", "formId"],
            additionalProperties: false,
        },
    },
    {
        name: "xedit_find_records_by_pattern",
        // NOTE ON SIZE: this tool's 14-property filter surface (parentFormId,
        // signatures, 5 *Regex fields, 2 *Pattern fields, pagination/drainAll)
        // is inherent to apply_filter's real parameter count, not description
        // bloat — see the schema-size unit test's allowlist for the byte floor.
        // Pagination/drainAll contract details and the *Regex/*Pattern mutual
        // exclusivity are in skills/xedit-automation/SKILL.md ("Filtering
        // records at scale").
        description: "Filters records by parentFormId, signatures, or EditorID/name regex or wildcard; at least one predicate required.",
        inputSchema: {
            type: "object",
            properties: {
                file: {
                    type: "string",
                    minLength: 1,
                    description: "Plugin filename to scope the filter.",
                },
                parentFormId: {
                    type: "string",
                    pattern: FORM_ID_PATTERN,
                    description: "Parent FormID; restricts matches to its children.",
                },
                signatures: {
                    type: "array",
                    items: { type: "string", minLength: 1 },
                    minItems: 1,
                    description: "4-char record signatures to include, e.g. REFR.",
                },
                editorIdRegex: {
                    type: "string",
                    description: "Regex against EditorID (array=OR). Excludes editorIdPattern.",
                },
                displayNameRegex: {
                    type: "string",
                    description: "Regex against display name (array=OR). Excludes displayNamePattern.",
                },
                fullNameRegex: {
                    type: "string",
                    description: "Regex against FULL name (array=OR).",
                },
                baseEditorIdRegex: {
                    type: "string",
                    description: "Regex against base EditorID (array=OR).",
                },
                baseDisplayNameRegex: {
                    type: "string",
                    description: "Regex against base display name (array=OR).",
                },
                editorIdPattern: {
                    type: "string",
                    description: "Wildcard against EditorID. Excludes editorIdRegex.",
                },
                displayNamePattern: {
                    type: "string",
                    description: "Wildcard against display name. Excludes displayNameRegex.",
                },
                limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: 100,
                    description: "Max matches per page, 1-100.",
                },
                offset: {
                    type: "integer",
                    minimum: 0,
                    description: "Matched records to skip (pagination).",
                },
                drainAll: {
                    type: "boolean",
                    description: "Aggregate all pages server-side (capped).",
                },
                compact: {
                    type: "boolean",
                    description: "Trim each match to locator + EditorID only.",
                },
                maxMatches: {
                    type: "integer",
                    minimum: 1,
                    maximum: 5000,
                    description: "With drainAll: raises the match cap (max 5000).",
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: "xedit_create_child_record",
        // Full three-shape recipe (CELL/DIAL/QUST vs WRLD-persistent vs
        // WRLD-exterior) + contract/support-key references live in
        // skills/xedit-automation/SKILL.md ("records.create parent-spec").
        description: "MUTATING; requires -IKnowWhatImDoing. Creates a child record under a parent.",
        inputSchema: {
            type: "object",
            properties: {
                targetFile: {
                    type: "string",
                    minLength: 1,
                    description: "New record's plugin filename.",
                },
                signature: {
                    type: "string",
                    minLength: 4,
                    maxLength: 4,
                    description: "Record signature (4 chars).",
                },
                parent: {
                    type: "object",
                    description: "Parent locator; subGroup or coords, not both.",
                    properties: {
                        file: {
                            type: "string",
                            minLength: 1,
                            description: "Parent's plugin filename.",
                        },
                        formId: {
                            type: "string",
                            pattern: FORM_ID_PATTERN,
                            description: "Parent FormID (hex, 0x optional).",
                        },
                        subGroup: {
                            type: "string",
                            minLength: 1,
                            description: "Sub-group, e.g. Persistent; excl. coords.",
                        },
                        coords: {
                            type: "array",
                            items: { type: "number" },
                            minItems: 2,
                            maxItems: 2,
                            description: "[x, y] coords; excl. subGroup.",
                        },
                    },
                    required: ["file", "formId"],
                    additionalProperties: false,
                },
                editorId: {
                    type: "string",
                    minLength: 1,
                    description: "Optional EditorID.",
                },
                formData: {
                    type: "object",
                    additionalProperties: true,
                },
            },
            required: ["targetFile", "signature", "parent"],
            additionalProperties: false,
        },
    },
    {
        name: "xedit_navigate_ancestry",
        description: "Resolves the ancestor chain (CELL>WRLD, DIAL>INFO, QUST sub-tree, etc.) for a record. Pass {file, formId} OR {editorId, signature?}.",
        inputSchema: {
            type: "object",
            properties: {
                file: {
                    type: "string",
                    minLength: 1,
                    description: "Plugin filename for {file, formId} mode. Omit in editorId mode.",
                },
                formId: {
                    type: "string",
                    pattern: FORM_ID_PATTERN,
                    description: "FormID hex for {file, formId} mode. Omit in editorId mode.",
                },
                editorId: {
                    type: "string",
                    minLength: 1,
                    description: "EditorID for {editorId} mode. Omit in {file, formId} mode.",
                },
                signature: {
                    type: "string",
                    description: "Optional 4-char record signature filter, used only in editorId mode.",
                },
            },
            additionalProperties: false,
        },
    },
    {
        name: "xedit_call",
        // The scripts.write + scripts.run multi-record recipe lives in
        // skills/xedit-automation/SKILL.md ("Atomic passthrough").
        description: "Atomic passthrough for native daemon commands with no dedicated intent tool; still runs the full validation/audit pipeline.",
        inputSchema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "Native daemon command name, e.g. 'records.get', 'records.list', 'scripts.run'.",
                },
                args: {
                    type: "object",
                    description: "Args object for the command; shape depends on command (see xedit_list_capabilities).",
                    additionalProperties: true,
                },
            },
            required: ["command"],
            additionalProperties: false,
        },
    },
];
// Helper to build the MCP CallTool response. Return type is loose so the
// SDK's expected ServerResult shape is satisfied without import-coupling.
function jsonResult(body, isError = false) {
    return {
        content: [{ type: "text", text: JSON.stringify(body) }],
        isError,
    };
}
export function statusFields(state, daemon, lastFlush) {
    const out = { status: state.status };
    if (lastFlush) {
        const previousSession = state.status === "ready"
            && daemon !== null
            && lastFlush.daemonPid !== undefined
            && lastFlush.daemonPid !== daemon.pid;
        out[previousSession ? "previousSessionFlush" : "lastFlush"] = lastFlush;
    }
    if (state.status === "starting") {
        out.startedAt = state.startedAt;
        out.elapsedSeconds = Math.round((Date.now() - state.startedAt) / 1000);
    }
    else if (state.status === "ready") {
        out.pid = state.pid;
        out.readySince = state.since;
        if (daemon)
            out.daemonPid = daemon.pid;
    }
    else if (state.status === "failed") {
        out.error = state.error;
        out.failedAt = state.at;
        if (daemon)
            out.daemonPid = daemon.pid;
    }
    return out;
}
export async function main() {
    const server = new Server({ name: "xedit-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
    let state = { status: "not_started" };
    let toolset = null;
    let daemonRef = null;
    let launchGeneration = 0;
    // Tracks the in-flight launch (state "starting") so xedit_stop/xedit_restart
    // can actually cancel it. Before this existed, stopping mid-launch only
    // cleared MCP-side state - daemonRef was still null at that point (it's set
    // after launchDaemon resolves), so there was nothing for `current.stop()` to
    // act on and the spawned `xedit-client.ps1 process launch` child (and
    // anything it had already spawned) kept running orphaned indefinitely.
    let launchAbortController = null;
    const pendingSaveTracker = new PendingSaveTracker();
    let lastFlush;
    const audit = createAuditLogger({ baseDir: join(tmpdir(), "xedit-mcp-audit") });
    function clearRuntimeState(next = { status: "not_started" }) {
        launchGeneration += 1;
        state = next;
        toolset = null;
        daemonRef = null;
        // Cancel an in-flight launch, if any - without this, stopping while
        // state.status is "starting" (daemonRef still null, launchDaemon() not
        // yet resolved) had nothing to act on: the launchGeneration bump above
        // only gets checked AFTER launchDaemon() resolves, so a launch stuck
        // earlier than that (e.g. inside the outer `process launch` invocation)
        // just kept running orphaned. See launchAbortController's declaration
        // comment for the directly-observed symptom this fixes.
        if (launchAbortController) {
            launchAbortController.abort();
            launchAbortController = null;
        }
        pendingSaveTracker.clearForSessionTransition();
    }
    async function getDirtyState() {
        if (state.status !== "ready" || !daemonRef) {
            return {
                ok: false,
                body: {
                    ok: true,
                    tool: "xedit_dirty",
                    data: withPendingShutdownSave({ ...statusFields(state, daemonRef, lastFlush), responsive: false }, pendingSaveTracker.snapshot()),
                    hint: lifecycleNotReadyHint(state.status, daemonRef !== null, lastFlush),
                },
            };
        }
        try {
            const probe = await refreshPendingSaveAuthority(daemonRef.adapter, pendingSaveTracker);
            if (!probe.ok) {
                const daemonError = probe.error !== null && typeof probe.error === "object"
                    ? probe.error
                    : undefined;
                const code = typeof daemonError?.code === "string" ? daemonError.code : "daemon_error";
                const message = typeof daemonError?.message === "string"
                    ? daemonError.message
                    : probe.error instanceof Error
                        ? probe.error.message
                        : "session.get_dirty_state failed";
                return {
                    ok: false,
                    body: {
                        ok: false,
                        tool: "xedit_dirty",
                        code,
                        summary: message,
                        hint: message,
                        data: withPendingShutdownSave({ ...statusFields(state, daemonRef, lastFlush), responsive: false }, pendingSaveTracker.snapshot()),
                    },
                };
            }
            const result = probe.result;
            const dirtyFiles = dirtyFileNames(result.dirtyFiles);
            const unsavedChangeCount = typeof result.unsavedChangeCount === "number" && Number.isFinite(result.unsavedChangeCount)
                ? result.unsavedChangeCount
                : dirtyFiles.length;
            return {
                ok: true,
                body: {
                    ok: true,
                    tool: "xedit_dirty",
                    data: withPendingShutdownSave({
                        ...statusFields(state, daemonRef, lastFlush),
                        dirty: result.dirty === true,
                        dirtyFiles,
                        unsavedChangeCount,
                    }, pendingSaveTracker.snapshot()),
                },
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                ok: false,
                body: {
                    ok: false,
                    tool: "xedit_dirty",
                    code: "daemon_error",
                    summary: msg,
                    hint: msg,
                    data: withPendingShutdownSave({ ...statusFields(state, daemonRef, lastFlush), responsive: false }, pendingSaveTracker.snapshot()),
                },
            };
        }
    }
    function kickoffLaunch(overrides = {}) {
        const decision = launchKickoffDecision(state.status, daemonRef !== null);
        if (!decision.allowed)
            return { kicked: false, reason: decision.reason };
        const opts = resolveLaunchOpts(overrides);
        if ("error" in opts) {
            clearRuntimeState({ status: "failed", error: opts.error, at: Date.now() });
            return { kicked: false, reason: opts.error };
        }
        const launchGen = ++launchGeneration;
        state = { status: "starting", startedAt: Date.now() };
        const abortController = new AbortController();
        launchAbortController = abortController;
        // Fire-and-forget: this promise resolves in the background while tool calls
        // return immediately. State is mutated in the closures below.
        void (async () => {
            try {
                const daemon = await launchDaemon({ ...opts, signal: abortController.signal });
                if (launchGen !== launchGeneration) {
                    try {
                        await daemon.stop();
                    }
                    catch {
                        /* best effort */
                    }
                    return;
                }
                daemonRef = daemon;
                toolset = buildServerToolset({
                    adapter: daemon.adapter,
                    sessionId: `mcp-${process.pid}-${Date.now()}`,
                    daemonPid: daemon.pid,
                    pendingSaveTracker,
                    audit,
                });
                state = { status: "ready", pid: daemon.pid, since: Date.now() };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (launchGen !== launchGeneration) {
                    return;
                }
                state = { status: "failed", error: msg, at: Date.now() };
                daemonRef = null;
                toolset = null;
            }
            finally {
                if (launchAbortController === abortController) {
                    launchAbortController = null;
                }
            }
        })();
        return { kicked: true };
    }
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOL_DEFINITIONS,
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const name = req.params.name;
        const args = (req.params.arguments ?? {});
        // ---- LIFECYCLE / HEALTH tools (always non-blocking) ----
        if (name === "xedit_status") {
            return jsonResult({ ok: true, tool: name, data: statusFields(state, daemonRef, lastFlush) });
        }
        if (name === "xedit_start") {
            // Extract override args (all optional). Unknown extra keys ignored.
            const overrides = {
                moRoot: typeof args.moRoot === "string" ? args.moRoot : undefined,
                launcherPath: typeof args.launcherPath === "string" ? args.launcherPath : undefined,
                gameMode: typeof args.gameMode === "string" ? args.gameMode : undefined,
                dataPath: typeof args.dataPath === "string" ? args.dataPath : undefined,
                pluginsFile: typeof args.pluginsFile === "string" ? args.pluginsFile : undefined,
                iKnowWhatImDoing: args.iKnowWhatImDoing === true ? true : undefined,
                starfieldRedPill: args.starfieldRedPill === false ? false : undefined,
                moProfile: typeof args.moProfile === "string" ? args.moProfile : undefined,
            };
            const kick = kickoffLaunch(overrides);
            const body = {
                ok: true,
                tool: name,
                data: statusFields(state, daemonRef, lastFlush),
                kicked: kick.kicked,
                message: kick.kicked
                    ? "Daemon launch initiated in the background. Poll xedit_status until status='ready'."
                    : kick.reason === "already_ready"
                        ? "Daemon is already ready."
                        : kick.reason === "already_starting"
                            ? "Daemon launch already in progress. Poll xedit_status until status='ready'."
                            : kick.reason === "retained_managed_process"
                                ? lifecycleNotReadyHint(state.status, daemonRef !== null, lastFlush)
                                : (kick.reason ?? "Launch could not be initiated."),
            };
            return jsonResult(body);
        }
        if (name === "xedit_health") {
            if (state.status === "failed" && daemonRef && lastFlush?.daemonExited === false) {
                const current = daemonRef;
                const updated = await retryFailedFlushExit({
                    waitForExit: current.waitForExit,
                    tracker: pendingSaveTracker,
                    lastFlush,
                    timeoutMs: 1_000,
                    onConfirmedExit: (summary) => {
                        lastFlush = summary;
                        clearRuntimeState();
                    },
                });
                if (updated) {
                    return jsonResult({
                        ok: true,
                        tool: name,
                        data: { ...statusFields(state, daemonRef, lastFlush), responsive: false },
                        message: "Delayed xEdit exit confirmed; lifecycle state cleared.",
                    });
                }
            }
            if (state.status !== "ready" || !daemonRef) {
                return jsonResult({
                    ok: true,
                    tool: name,
                    data: { ...statusFields(state, daemonRef, lastFlush), responsive: false },
                    hint: lifecycleNotReadyHint(state.status, daemonRef !== null, lastFlush),
                });
            }
            try {
                const ping = await daemonRef.adapter.call({ command: "system.ping", args: {} });
                return jsonResult({
                    ok: true,
                    tool: name,
                    data: {
                        ...statusFields(state, daemonRef, lastFlush),
                        responsive: ping.ok === true,
                        pingEnvelope: ping,
                    },
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return jsonResult({
                    ok: true,
                    tool: name,
                    data: {
                        ...statusFields(state, daemonRef, lastFlush),
                        responsive: false,
                        pingError: msg,
                    },
                    hint: "Daemon claimed ready but did not respond to system.ping. It may be a zombie; consider restarting MO2.",
                });
            }
        }
        if (name === "xedit_dirty") {
            const dirty = await getDirtyState();
            return jsonResult(dirty.body, !dirty.body.ok);
        }
        if (name === "xedit_flush") {
            if (state.status !== "ready" || !daemonRef) {
                return jsonResult({
                    ok: false,
                    tool: name,
                    code: "not_ready",
                    summary: `Daemon is not ready (status='${state.status}').`,
                    data: statusFields(state, daemonRef, lastFlush),
                    hint: "Call xedit_start, then poll xedit_status until status='ready'.",
                }, true);
            }
            const current = daemonRef;
            const flush = makeFlushHandler({
                adapter: current.adapter,
                tracker: pendingSaveTracker,
                waitForExit: current.waitForExit,
                getContext: () => ({ sessionId: `mcp-${process.pid}`, daemonPid: current.pid }),
                audit,
                onConfirmedExit: (summary) => {
                    lastFlush = summary;
                    clearRuntimeState();
                },
                onExitFailure: (message, summary) => {
                    if (summary)
                        lastFlush = summary;
                    state = { status: "failed", error: message, at: Date.now() };
                    toolset = null;
                },
            });
            const env = await flush(args);
            return jsonResult(env, !env.ok);
        }
        if (name === "xedit_stop") {
            const force = args.force === true;
            const dirty = state.status === "ready" ? await getDirtyState() : undefined;
            const dirtyDecision = state.status === "ready"
                ? dirtyProbeLifecycleDecision("stop", dirty?.ok === true, force)
                : { allowed: true, operation: "stop" };
            if (!dirtyDecision.allowed) {
                await audit.append({
                    tool: name,
                    argsHash: hashArgs(args),
                    decision: "refused",
                    ok: false,
                    code: dirtyDecision.code,
                    daemonPid: daemonRef?.pid,
                    force,
                    risk: "dirty_state_probe_unavailable",
                    dirtyStateProbeUnavailable: true,
                });
                return jsonResult({
                    ok: false,
                    tool: name,
                    code: dirtyDecision.code,
                    summary: "Could not verify xEdit dirty state. Refusing to stop without force=true.",
                    data: dirty?.body.data,
                    hint: "Retry xedit_dirty, or use force=true to explicitly accept the unavailable dirty-state readback risk.",
                }, true);
            }
            const dirtyStateProbeRisk = dirtyDecision.risk
                ? { risk: dirtyDecision.risk, force: true }
                : undefined;
            const pendingRisk = pendingSaveLifecycleRisk("stop", pendingSaveTracker.snapshot(), force);
            if (pendingRisk && "code" in pendingRisk) {
                return jsonResult({ ok: false, tool: name, ...pendingRisk }, true);
            }
            if (state.status === "not_started") {
                if (pendingRisk && "abandonment" in pendingRisk) {
                    await audit.append({
                        tool: name,
                        argsHash: hashArgs(args),
                        decision: "warned",
                        ok: true,
                        risk: pendingRisk.risk,
                        pendingShutdownSave: pendingRisk.pendingShutdownSave,
                        force,
                        dirtyStateProbeUnavailable: dirtyStateProbeRisk !== undefined,
                    });
                    clearRuntimeState();
                }
                return jsonResult({
                    ok: true,
                    tool: name,
                    data: statusFields(state, daemonRef, lastFlush),
                    message: "Daemon already stopped.",
                    ...(pendingRisk && "abandonment" in pendingRisk ? { risk: pendingRisk } : {}),
                    ...(dirtyStateProbeRisk ? { dirtyStateProbeRisk } : {}),
                });
            }
            if (state.status === "ready") {
                if (dirty?.ok) {
                    const data = dirty.body.data;
                    if (data.dirty && !force) {
                        return jsonResult({
                            ok: false,
                            tool: name,
                            code: "dirty_state",
                            summary: "xEdit has unsaved changes. Refusing to stop without force=true.",
                            data,
                            hint: "Either save the dirty files first, or call xedit_stop({ force: true }) to abandon the in-memory edits.",
                        }, true);
                    }
                }
            }
            const current = daemonRef;
            if (pendingRisk && "abandonment" in pendingRisk) {
                await audit.append({
                    tool: name,
                    argsHash: hashArgs(args),
                    decision: "warned",
                    ok: true,
                    daemonPid: state.status === "ready" ? state.pid : undefined,
                    risk: pendingRisk.risk,
                    pendingShutdownSave: pendingRisk.pendingShutdownSave,
                    force,
                    dirtyStateProbeUnavailable: dirtyStateProbeRisk !== undefined,
                });
            }
            else if (dirtyStateProbeRisk) {
                await audit.append({
                    tool: name,
                    argsHash: hashArgs(args),
                    decision: "warned",
                    ok: true,
                    daemonPid: state.status === "ready" ? state.pid : undefined,
                    risk: dirtyStateProbeRisk.risk,
                    force,
                    dirtyStateProbeUnavailable: true,
                });
            }
            clearRuntimeState();
            if (current) {
                try {
                    await current.stop();
                }
                catch {
                    /* best effort */
                }
            }
            return jsonResult({
                ok: true,
                tool: name,
                data: { status: "not_started" },
                message: "Daemon stopped and MCP runtime state cleared.",
                ...(pendingRisk && "abandonment" in pendingRisk ? { risk: pendingRisk } : {}),
                ...(dirtyStateProbeRisk ? { dirtyStateProbeRisk } : {}),
            });
        }
        if (name === "xedit_restart") {
            const force = args.force === true;
            const dirty = state.status === "ready" ? await getDirtyState() : undefined;
            const dirtyDecision = state.status === "ready"
                ? dirtyProbeLifecycleDecision("restart", dirty?.ok === true, force)
                : { allowed: true, operation: "restart" };
            if (!dirtyDecision.allowed) {
                await audit.append({
                    tool: name,
                    argsHash: hashArgs(args),
                    decision: "refused",
                    ok: false,
                    code: dirtyDecision.code,
                    daemonPid: daemonRef?.pid,
                    force,
                    risk: "dirty_state_probe_unavailable",
                    dirtyStateProbeUnavailable: true,
                });
                return jsonResult({
                    ok: false,
                    tool: name,
                    code: dirtyDecision.code,
                    summary: "Could not verify xEdit dirty state. Refusing to restart without force=true.",
                    data: dirty?.body.data,
                    hint: "Retry xedit_dirty, or use force=true to explicitly accept the unavailable dirty-state readback risk.",
                }, true);
            }
            const dirtyStateProbeRisk = dirtyDecision.risk
                ? { risk: dirtyDecision.risk, force: true }
                : undefined;
            const pendingRisk = pendingSaveLifecycleRisk("restart", pendingSaveTracker.snapshot(), force);
            if (pendingRisk && "code" in pendingRisk) {
                return jsonResult({ ok: false, tool: name, ...pendingRisk }, true);
            }
            const overrides = {
                moRoot: typeof args.moRoot === "string" ? args.moRoot : undefined,
                launcherPath: typeof args.launcherPath === "string" ? args.launcherPath : undefined,
                gameMode: typeof args.gameMode === "string" ? args.gameMode : undefined,
                dataPath: typeof args.dataPath === "string" ? args.dataPath : undefined,
                pluginsFile: typeof args.pluginsFile === "string" ? args.pluginsFile : undefined,
                iKnowWhatImDoing: args.iKnowWhatImDoing === true ? true : undefined,
                starfieldRedPill: args.starfieldRedPill === false ? false : undefined,
                moProfile: typeof args.moProfile === "string" ? args.moProfile : undefined,
            };
            if (state.status === "ready") {
                if (dirty?.ok) {
                    const data = dirty.body.data;
                    if (data.dirty && !force) {
                        return jsonResult({
                            ok: false,
                            tool: name,
                            code: "dirty_state",
                            summary: "xEdit has unsaved changes. Refusing to restart without force=true.",
                            data,
                            hint: "Either save the dirty files first, or call xedit_restart({ force: true, ... }) to abandon the in-memory edits and relaunch with the new overrides.",
                        }, true);
                    }
                }
            }
            const current = daemonRef;
            if (pendingRisk && "abandonment" in pendingRisk) {
                await audit.append({
                    tool: name,
                    argsHash: hashArgs(args),
                    decision: "warned",
                    ok: true,
                    daemonPid: state.status === "ready" ? state.pid : undefined,
                    risk: pendingRisk.risk,
                    pendingShutdownSave: pendingRisk.pendingShutdownSave,
                    force,
                    dirtyStateProbeUnavailable: dirtyStateProbeRisk !== undefined,
                });
            }
            else if (dirtyStateProbeRisk) {
                await audit.append({
                    tool: name,
                    argsHash: hashArgs(args),
                    decision: "warned",
                    ok: true,
                    daemonPid: state.status === "ready" ? state.pid : undefined,
                    risk: dirtyStateProbeRisk.risk,
                    force,
                    dirtyStateProbeUnavailable: true,
                });
            }
            clearRuntimeState();
            if (current) {
                try {
                    await current.stop();
                }
                catch {
                    /* best effort */
                }
            }
            const kick = kickoffLaunch(overrides);
            return jsonResult({
                ok: true,
                tool: name,
                data: statusFields(state, daemonRef, lastFlush),
                kicked: kick.kicked,
                message: kick.kicked
                    ? "Daemon restart initiated in the background. Poll xedit_status until status='ready'."
                    : (kick.reason ?? "Restart could not be initiated."),
                ...(pendingRisk && "abandonment" in pendingRisk ? { risk: pendingRisk } : {}),
                ...(dirtyStateProbeRisk ? { dirtyStateProbeRisk } : {}),
            });
        }
        // ---- DOMAIN tools ----
        if (name === "xedit_session") {
            if (state.status === "ready" && toolset) {
                try {
                    const env = await toolset.invoke("xedit_session", args);
                    return jsonResult(env, !env.ok);
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    return jsonResult({ ok: false, tool: name, code: "internal_error", summary: msg, hint: msg }, true);
                }
            }
            // Not ready: auto-kick the launch if not yet started, then surface status.
            if (state.status === "not_started") {
                kickoffLaunch();
            }
            return jsonResult({
                ok: true,
                tool: name,
                data: statusFields(state, daemonRef, lastFlush),
                hint: lifecycleNotReadyHint(state.status, daemonRef !== null, lastFlush),
            });
        }
        // Other domain tools require ready
        if (state.status !== "ready" || !toolset) {
            return jsonResult({
                ok: false,
                tool: name,
                code: "not_ready",
                summary: `Daemon is not ready (status='${state.status}').`,
                data: statusFields(state, daemonRef, lastFlush),
                hint: lifecycleNotReadyHint(state.status, daemonRef !== null, lastFlush),
            }, true);
        }
        try {
            const env = await toolset.invoke(name, args);
            return jsonResult(env, !env.ok);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return jsonResult({ ok: false, tool: name, code: "internal_error", summary: msg, hint: msg }, true);
        }
    });
    const shutdown = async (signal) => {
        process.stderr.write(`xedit-mcp received ${signal}, shutting down...\n`);
        if (daemonRef) {
            try {
                await daemonRef.stop();
            }
            catch { /* best effort */ }
        }
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    await server.connect(new StdioServerTransport());
}
// Detect "invoked as the main entry" cross-platform. On Windows, naive string
// compare against `file://${argv[1]}` fails because of backslash + slash-count
// differences. Use pathToFileURL to normalize. (See earlier P5 bugfix commit.)
const invokedAsMain = (() => {
    const argv = process.argv[1];
    if (!argv)
        return false;
    try {
        return import.meta.url === pathToFileURL(argv).href;
    }
    catch {
        return false;
    }
})();
if (invokedAsMain) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map