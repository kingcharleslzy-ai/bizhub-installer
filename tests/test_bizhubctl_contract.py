from __future__ import annotations

import importlib.machinery
import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def load_cli():
    loader = importlib.machinery.SourceFileLoader("bizhubctl_module", str(ROOT / "bizhubctl"))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def test_cli_has_only_bounded_lifecycle_commands():
    cli = load_cli()
    choices = cli.parser()._subparsers._group_actions[0].choices
    assert set(choices) == {"preflight", "plan", "install", "verify", "status", "backup", "restore", "update", "uninstall"}
    assert "purge" not in choices


def test_network_binding_rules_fail_closed():
    cli = load_cli()
    cli.validate_bind("private", "192.168.50.10", "")
    cli.validate_bind("domain", "127.0.0.1", "bizhub.example.com")
    for values in [
        ("private", "0.0.0.0", ""),
        ("private", "8.8.8.8", ""),
        ("domain", "192.168.1.5", "bizhub.example.com"),
        ("cloudflare", "127.0.0.1", ""),
    ]:
        with pytest.raises(ValueError):
            cli.validate_bind(*values)


def test_plan_hash_detects_any_change():
    cli = load_cli()
    plan = {"contract": cli.PLAN_CONTRACT, "source": {"commit": "a" * 40}, "plan_hash": "ignored"}
    first = cli.plan_hash(plan)
    plan["source"]["commit"] = "b" * 40
    assert cli.plan_hash(plan) != first


def test_fixed_paths_match_contract():
    cli = load_cli()
    assert str(cli.ETC).endswith("/etc/bizhub")
    assert str(cli.DATA).endswith("/var/lib/bizhub")
    assert str(cli.APP_DATA).endswith("/var/lib/bizhub/data")
    assert str(cli.BACKUPS).endswith("/var/backups/bizhub")
    assert str(cli.STATE).endswith("/var/lib/bizhub/install-state.json")
