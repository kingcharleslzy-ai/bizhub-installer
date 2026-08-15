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


def test_build_image_binds_the_planned_core_commit(monkeypatch):
    cli = load_cli()
    commands = []
    monkeypatch.setattr(cli, "run", lambda command, **_: commands.append(command))
    commit = "a" * 40
    assert cli.build_image(
        {
            "source": {"commit": commit},
            "deployment_image": {"mode": "build_public_source", "core_revision": commit},
        }
    ) == f"bizhub:{commit[:12]}"
    build_arg = commands[0].index("--build-arg")
    assert commands[0][build_arg + 1] == f"BIZHUB_CORE_COMMIT={commit}"


def image_fixture(*, derived=False):
    core_revision = "a" * 40
    private_revision = "b" * 40
    labels = {"org.opencontainers.image.revision": core_revision}
    environment = [f"BIZHUB_CORE_COMMIT={core_revision}"]
    layers = ["sha256:" + "1" * 64, "sha256:" + "2" * 64]
    if derived:
        labels = {
            "org.opencontainers.image.base.revision": core_revision,
            "org.opencontainers.image.revision": private_revision,
            "com.bizhub.extension.mode": "read-only-reference",
        }
        environment.extend(
            [
                f"BIZHUB_EXPECTED_CORE_COMMIT={core_revision}",
                f"BIZHUB_PRIVATE_EXTENSION_COMMIT={private_revision}",
                "BIZHUB_EXTENSION_MODULES=customer_reference",
            ]
        )
        layers.append("sha256:" + "3" * 64)
    return {
        "Id": "sha256:" + ("d" if derived else "c") * 64,
        "Config": {
            "Labels": labels,
            "Env": environment,
            "Entrypoint": None,
            "Cmd": ["uvicorn", "bizhub.main:app"],
            "Healthcheck": {"Test": ["CMD", "python", "health.py"]},
            "User": "10001:10001",
            "ExposedPorts": {"8080/tcp": {}},
        },
        "RootFS": {"Layers": layers},
    }


def test_derived_image_plan_binds_immutable_ids_layers_and_revisions(monkeypatch):
    cli = load_cli()
    core = image_fixture()
    derived = image_fixture(derived=True)
    monkeypatch.setattr(cli, "inspect_docker_image", lambda reference: {"core": core, "derived": derived}[reference])
    result = cli.deployment_image_plan(
        candidate_core_image="core",
        candidate_image="derived",
        core_revision="a" * 40,
    )
    assert result == {
        "mode": "prebuilt_customer_private",
        "core_image_id": core["Id"],
        "candidate_image_id": derived["Id"],
        "core_revision": "a" * 40,
        "private_revision": "b" * 40,
        "extension_mode": "read-only-reference",
        "extension_modules": ["customer_reference"],
    }


def test_derived_image_plan_requires_a_pair_and_real_ancestry(monkeypatch):
    cli = load_cli()
    with pytest.raises(ValueError, match="supplied together"):
        cli.deployment_image_plan(candidate_core_image="core", candidate_image=None, core_revision="a" * 40)

    core = image_fixture()
    derived = image_fixture(derived=True)
    derived["RootFS"]["Layers"][0] = "sha256:" + "9" * 64
    monkeypatch.setattr(cli, "inspect_docker_image", lambda reference: {"core": core, "derived": derived}[reference])
    with pytest.raises(ValueError, match="does not extend"):
        cli.deployment_image_plan(
            candidate_core_image="core",
            candidate_image="derived",
            core_revision="a" * 40,
        )


def test_build_image_uses_only_the_approved_derived_image_id(monkeypatch):
    cli = load_cli()
    deployment = {
        "mode": "prebuilt_customer_private",
        "core_image_id": "sha256:" + "c" * 64,
        "candidate_image_id": "sha256:" + "d" * 64,
        "core_revision": "a" * 40,
        "private_revision": "b" * 40,
        "extension_mode": "read-only-reference",
        "extension_modules": ["customer_reference"],
    }
    monkeypatch.setattr(cli, "deployment_image_plan", lambda **_: deployment)
    monkeypatch.setattr(cli, "run", lambda *_args, **_kwargs: pytest.fail("derived apply must not build an image"))
    assert cli.build_image({"source": {"commit": "a" * 40}, "deployment_image": deployment}) == deployment[
        "candidate_image_id"
    ]


@pytest.mark.parametrize("remote", [
    "https://github.com/kingcharleslzy-ai/bizhub-installer",
    "https://github.com/kingcharleslzy-ai/bizhub-installer.git",
    "git@github.com:kingcharleslzy-ai/bizhub-installer",
    "git@github.com:kingcharleslzy-ai/bizhub-installer.git",
])
def test_source_identity_accepts_only_canonical_equivalent_remotes(monkeypatch, remote):
    cli = load_cli()

    def value(*args):
        if args == ("rev-parse", "HEAD"):
            return "a" * 40
        if args == ("status", "--porcelain"):
            return ""
        if args == ("tag", "--points-at", "HEAD"):
            return f"v{cli.VERSION}"
        if args == ("remote", "get-url", "origin"):
            return remote
        if args == ("rev-parse", "HEAD^{tree}"):
            return "b" * 40
        raise AssertionError(args)

    monkeypatch.setattr(cli, "git_value", value)
    assert cli.source_identity()["repository"] == remote


def test_source_identity_rejects_lookalike_repository(monkeypatch):
    cli = load_cli()
    monkeypatch.setattr(cli, "git_value", lambda *args: {
        ("rev-parse", "HEAD"): "a" * 40,
        ("status", "--porcelain"): "",
        ("tag", "--points-at", "HEAD"): f"v{cli.VERSION}",
        ("remote", "get-url", "origin"): "https://github.com/attacker/bizhub-installer.git",
    }[args])
    with pytest.raises(RuntimeError):
        cli.source_identity()


def test_fixed_paths_match_contract():
    cli = load_cli()
    assert str(cli.ETC).endswith("/etc/bizhub")
    assert str(cli.DATA).endswith("/var/lib/bizhub")
    assert str(cli.APP_DATA).endswith("/var/lib/bizhub/data")
    assert str(cli.BACKUPS).endswith("/var/backups/bizhub")
    assert str(cli.STATE).endswith("/var/lib/bizhub/install-state.json")
