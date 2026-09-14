$ErrorActionPreference = "Stop"

# mods.create must never reach IOrganizer.createMod for a folder that already
# exists under mods/ but is not registered: createMod opens MO2's modal
# "Mod Exists" dialog on the main thread, which blocks the broker pump and times
# out the client's pipe call while the GUI waits for a human. Observed live
# (2026-09-13/14) twice, both times after a folder had been dropped into mods/
# by hand before mods.create was called for the same name.

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$bridgeSourcePath = Join-Path $repoRoot "tools/mo2-control-plane/live-bridge/mo2_agent_control.py"
if (-not (Test-Path $bridgeSourcePath -PathType Leaf)) {
    throw "Missing live bridge source: tools/mo2-control-plane/live-bridge/mo2_agent_control.py"
}

$harness = @'
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import types

module_path = pathlib.Path(sys.argv[1])

mobase = types.ModuleType("mobase")

class IPluginTool:
    pass

class VersionInfo:
    def __init__(self, *parts):
        self.parts = parts

mobase.IPluginTool = IPluginTool
mobase.VersionInfo = VersionInfo
mobase.GuessedString = str
sys.modules["mobase"] = mobase

spec = importlib.util.spec_from_file_location("mo2_agent_control", str(module_path))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeMod:
    def __init__(self, name, path):
        self._name = name
        self._path = path

    def name(self):
        return self._name

    def absolutePath(self):
        return self._path


class FakeModList:
    def __init__(self):
        self.registered = {}
        self.priorities = {}

    def getMod(self, name):
        return self.registered.get(name)

    def priority(self, name):
        return self.priorities.get(name, 7)

    def setPriority(self, name, value):
        self.priorities[name] = value


class FakeOrganizer:
    def __init__(self, mods_path):
        self._mods_path = mods_path
        self._list = FakeModList()
        self.create_calls = []
        self.refresh_calls = 0

    def modList(self):
        return self._list

    def modsPath(self):
        return self._mods_path

    def refresh(self):
        # Real MO2 adopts unregistered folders under mods/ on refresh (GUI F5).
        self.refresh_calls += 1
        for entry in os.listdir(self._mods_path):
            full = os.path.join(self._mods_path, entry)
            if os.path.isdir(full):
                self._list.registered.setdefault(entry, FakeMod(entry, full))

    def createMod(self, guessed):
        self.create_calls.append(str(guessed))
        mod = FakeMod(str(guessed), os.path.join(self._mods_path, str(guessed)))
        self._list.registered[str(guessed)] = mod
        return mod

    def modDataChanged(self, mod):
        pass


def run(name, mods_path, payload):
    organizer = FakeOrganizer(mods_path)
    handlers = module.build_command_handlers(
        organizer=organizer,
        main_thread_pump=module.MainThreadCallPump(),
    )
    response = module.dispatch_transport_request(
        {
            "protocol_version": "1",
            "request_id": "req-" + name,
            "session_id": "sess-" + name,
            "method": "mods.create",
            "payload": payload,
        },
        handlers,
    )
    return {
        "response": response,
        "createCalls": organizer.create_calls,
        "refreshCalls": organizer.refresh_calls,
    }


with tempfile.TemporaryDirectory() as mods_path:
    os.makedirs(os.path.join(mods_path, "DroppedInByHand"))

    refused = run("refused", mods_path, {"name": "DroppedInByHand"})
    adopted = run("adopted", mods_path, {"name": "DroppedInByHand", "adopt_existing": True, "priority": 3})
    fresh = run("fresh", mods_path, {"name": "Fresh"})
    bad_flag = run("badflag", mods_path, {"name": "Fresh2", "adopt_existing": "yes"})

print(json.dumps({
    "refused": refused,
    "adopted": adopted,
    "fresh": fresh,
    "badFlag": bad_flag,
}))
'@

$output = & python -c $harness $bridgeSourcePath 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "mods.create existing-folder harness should execute cleanly: $($output -join "`n")"
}
$summary = (($output | ForEach-Object { $_.ToString() }) -join "`n") | ConvertFrom-Json -AsHashtable -ErrorAction Stop

# 1. Existing unregistered folder, no adopt flag: refuse, and never call createMod.
if ($summary.refused.response.ok) {
    throw "mods.create on an existing unregistered folder should be refused, not routed to createMod"
}
if ($summary.refused.response.error.message -notmatch "Mod Exists") {
    throw "Refusal should explain the modal it is avoiding: $($summary.refused.response.error.message)"
}
if ($summary.refused.response.error.message -notmatch "adopt_existing") {
    throw "Refusal should point at the adopt_existing escape hatch"
}
if ($summary.refused.createCalls.Count -ne 0) {
    throw "createMod must not be called for an existing unregistered folder"
}

# 2. adopt_existing=true: register via refresh, honor priority, never call createMod.
if (-not $summary.adopted.response.ok) {
    throw "adopt_existing should succeed: $($summary.adopted.response.error.message)"
}
if ($summary.adopted.response.result.adopted -ne $true -or $summary.adopted.response.result.created -ne $false) {
    throw "adopt_existing result should report adopted=true, created=false"
}
if ($summary.adopted.refreshCalls -lt 1) {
    throw "adopt_existing should refresh the organizer so MO2 registers the folder"
}
if ($summary.adopted.createCalls.Count -ne 0) {
    throw "adopt_existing must not call createMod"
}
if ($summary.adopted.response.result.priority -ne 3) {
    throw "adopt_existing should still honor a requested priority"
}

# 3. Genuinely new name: normal createMod path unchanged.
if (-not $summary.fresh.response.ok -or $summary.fresh.response.result.created -ne $true) {
    throw "A genuinely new mod name should still be created normally: $($summary.fresh.response.error.message)"
}
if (($summary.fresh.createCalls -join "|") -ne "Fresh") {
    throw "createMod should be called exactly once for a new name"
}

# 4. Non-bool adopt_existing is rejected up front.
if ($summary.badFlag.response.ok -or $summary.badFlag.response.error.message -notmatch "adopt_existing: bool") {
    throw "adopt_existing must be validated as a bool"
}

Write-Host "MO2 mods.create existing-folder checks passed."
