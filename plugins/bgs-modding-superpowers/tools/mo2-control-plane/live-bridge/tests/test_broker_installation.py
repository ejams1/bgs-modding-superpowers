"""Tests for installation.* broker commands."""

import ctypes
import importlib
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch


LIVE_BRIDGE_DIR = Path(__file__).resolve().parents[1]


class _FakeWinFunction:
    def __call__(self, *args, **kwargs):
        return 1


class _FakeWinDll:
    def __getattr__(self, name):
        function = _FakeWinFunction()
        setattr(self, name, function)
        return function


def _load_bridge(monkeypatch):
    monkeypatch.syspath_prepend(str(LIVE_BRIDGE_DIR))
    monkeypatch.setitem(
        sys.modules,
        "mobase",
        types.SimpleNamespace(IPluginTool=object, VersionInfo=lambda *args: args),
    )
    monkeypatch.setattr(ctypes, "WinDLL", lambda *args, **kwargs: _FakeWinDll(), raising=False)

    sys.modules.pop("mo2_agent_control", None)
    return importlib.import_module("mo2_agent_control")


def test_installation_install_local_archive_success(monkeypatch, tmp_path):
    bridge = _load_bridge(monkeypatch)

    archive = tmp_path / "TestMod.7z"
    archive.write_bytes(b"fake archive")

    new_mod = MagicMock()
    new_mod.name.return_value = "TestMod"
    new_mod.absolutePath.return_value = "/path/to/mods/TestMod"
    organizer = MagicMock()
    organizer.installMod.return_value = new_mod
    pump = MagicMock()
    pump.invoke_blocking.side_effect = lambda fn, timeout_s=120: fn()

    result = bridge._handle_installation_install_local_archive(
        organizer,
        pump,
        {
            "archive_path": str(archive),
            "name_suggestion": "TestMod",
        },
    )

    assert result["ok"] is True
    r = result["result"]
    assert r["name"] == "TestMod"
    assert r["installation_file"] == str(archive)


def test_installation_install_local_archive_canceled(monkeypatch, tmp_path):
    """installMod returns None on cancellation or failure."""
    bridge = _load_bridge(monkeypatch)

    archive = tmp_path / "CanceledMod.7z"
    archive.write_bytes(b"fake archive")

    organizer = MagicMock()
    organizer.installMod.return_value = None
    pump = MagicMock()
    pump.invoke_blocking.side_effect = lambda fn, timeout_s=120: fn()

    result = bridge._handle_installation_install_local_archive(
        organizer,
        pump,
        {
            "archive_path": str(archive),
            "name_suggestion": "",
        },
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "internal_error"
    assert "None" in result["error"]["message"] or "canceled" in result["error"]["message"].lower()


def test_installation_install_local_archive_missing_file(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    organizer = MagicMock()
    pump = MagicMock()

    result = bridge._handle_installation_install_local_archive(
        organizer,
        pump,
        {
            "archive_path": "/nonexistent/path.7z",
        },
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "invalid_params"
    assert "not found" in result["error"]["message"].lower()


def test_installation_create_mod_from_directory_success(monkeypatch, tmp_path):
    bridge = _load_bridge(monkeypatch)

    new_mod = MagicMock()
    new_mod.name.return_value = "NewStaged"
    new_mod.absolutePath.return_value = "/path/to/mods/NewStaged"
    mod_list = MagicMock()
    mod_list.getMod.return_value = None
    organizer = MagicMock()
    organizer.modList.return_value = mod_list
    organizer.modsPath.return_value = str(tmp_path)
    organizer.createMod.return_value = new_mod
    pump = MagicMock()
    pump.invoke_blocking.side_effect = lambda fn, timeout_s=15: fn()

    with patch("mo2_agent_control.GuessedString", create=True, side_effect=lambda name: name):
        result = bridge._handle_installation_create_mod_from_directory(organizer, pump, {"name": "NewStaged"})

    assert result["ok"] is True
    r = result["result"]
    assert r["name"] == "NewStaged"
    assert r["absolute_path"] == "/path/to/mods/NewStaged"
    organizer.refresh.assert_called_once_with()


def test_installation_create_mod_from_directory_collision(monkeypatch):
    bridge = _load_bridge(monkeypatch)

    mod_list = MagicMock()
    mod_list.getMod.return_value = MagicMock()
    organizer = MagicMock()
    organizer.modList.return_value = mod_list
    pump = MagicMock()
    pump.invoke_blocking.side_effect = lambda fn, timeout_s=15: fn()

    with patch("mo2_agent_control.GuessedString", create=True, side_effect=lambda name: name):
        result = bridge._handle_installation_create_mod_from_directory(organizer, pump, {"name": "Existing"})

    assert result["ok"] is False
    assert result["error"]["code"] == "invalid_params"


def test_installation_create_mod_from_directory_refuses_unregistered_folder(monkeypatch, tmp_path):
    """U1: this handler is the sister createMod call site to mods.create and
    was left unguarded by the mods.create hang fix -- a folder dropped into
    mods/ by hand (or left behind by a prior aborted staging run) must be
    refused here too, never reach organizer.createMod(), and open MO2's
    blocking 'Mod Exists' modal. Unlike mods.create this handler has no
    adopt_existing escape hatch: Pattern A staging always wants a fresh empty
    mod."""
    bridge = _load_bridge(monkeypatch)

    (tmp_path / "StagedButUnregistered").mkdir()
    mod_list = MagicMock()
    mod_list.getMod.return_value = None
    organizer = MagicMock()
    organizer.modList.return_value = mod_list
    organizer.modsPath.return_value = str(tmp_path)
    pump = MagicMock()
    pump.invoke_blocking.side_effect = lambda fn, timeout_s=15: fn()

    with patch("mo2_agent_control.GuessedString", create=True, side_effect=lambda name: name):
        result = bridge._handle_installation_create_mod_from_directory(
            organizer, pump, {"name": "StagedButUnregistered"}
        )

    assert result["ok"] is False
    assert result["error"]["code"] == "mod_dir_exists_unregistered"
    assert result["error"]["details"]["existing_dir"] == str(tmp_path / "StagedButUnregistered")
    organizer.createMod.assert_not_called()


def test_installation_create_mod_from_directory_fails_closed_when_mods_path_unreadable(monkeypatch):
    """U3, applied to the second createMod call site: an unreadable
    modsPath() must refuse, not fall through to createMod."""
    bridge = _load_bridge(monkeypatch)

    mod_list = MagicMock()
    mod_list.getMod.return_value = None
    organizer = MagicMock()
    organizer.modList.return_value = mod_list
    # organizer.modsPath deliberately unconfigured -- see the mods.create
    # analogue of this test in test_broker_mods_commands.py.
    pump = MagicMock()
    pump.invoke_blocking.side_effect = lambda fn, timeout_s=15: fn()

    with patch("mo2_agent_control.GuessedString", create=True, side_effect=lambda name: name):
        result = bridge._handle_installation_create_mod_from_directory(organizer, pump, {"name": "Whatever"})

    assert result["ok"] is False
    assert result["error"]["code"] == "internal_error"
    organizer.createMod.assert_not_called()


def test_installation_create_mod_from_directory_sanitizes_name(monkeypatch, tmp_path):
    bridge = _load_bridge(monkeypatch)

    captured = {}
    new_mod = MagicMock()
    new_mod.name.return_value = "Sanitized"
    new_mod.absolutePath.return_value = "/m/Sanitized"
    mod_list = MagicMock()
    mod_list.getMod.return_value = None
    organizer = MagicMock()
    organizer.modList.return_value = mod_list
    organizer.modsPath.return_value = str(tmp_path)

    def _create(guessed_string):
        captured["name"] = guessed_string
        return new_mod

    organizer.createMod.side_effect = _create
    pump = MagicMock()
    pump.invoke_blocking.side_effect = lambda fn, timeout_s=15: fn()

    with patch("mo2_agent_control.GuessedString", create=True, side_effect=lambda name: name):
        result = bridge._handle_installation_create_mod_from_directory(organizer, pump, {"name": "Bad<>Name"})

    assert result["ok"] is True
    assert captured["name"] == "BadName"
