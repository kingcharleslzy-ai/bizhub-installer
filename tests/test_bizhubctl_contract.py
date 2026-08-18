from __future__ import annotations

import importlib.machinery
import importlib.util
from pathlib import Path
from types import SimpleNamespace

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
    cli.validate_bind("loopback", "127.0.0.1", "")
    cli.validate_bind("private", "192.168.50.10", "")
    cli.validate_bind("domain", "127.0.0.1", "bizhub.example.com")
    for values in [
        ("loopback", "0.0.0.0", ""),
        ("loopback", "127.0.0.1", "bizhub.example.com"),
        ("private", "0.0.0.0", ""),
        ("private", "8.8.8.8", ""),
        ("domain", "192.168.1.5", "bizhub.example.com"),
        ("cloudflare", "127.0.0.1", ""),
    ]:
        with pytest.raises(ValueError):
            cli.validate_bind(*values)


def test_resource_limits_are_bounded_and_convert_to_docker_values():
    cli = load_cli()
    limits = cli.resource_limits(1024, 512, 1000, 256)
    assert limits == {"memory_mib": 1024, "swap_mib": 512, "cpu_millicores": 1000, "pids_limit": 256}
    assert cli.expected_docker_resources({"resource_limits": limits}) == {
        "memory_bytes": 1024 * 1024 * 1024,
        "memory_swap_total_bytes": 1536 * 1024 * 1024,
        "nano_cpus": 1_000_000_000,
        "pids_limit": 256,
    }
    assert cli.expected_cgroup_resources({"resource_limits": limits}) == {
        "memory_max_bytes": 1024 * 1024 * 1024,
        "memory_swap_max_bytes": 512 * 1024 * 1024,
        "cpu_millicores": 1000,
        "pids_max": 256,
    }
    for values in [(255, 512, 1000, 256), (1024, -1, 1000, 256), (1024, 512, 249, 256), (1024, 512, 1000, 63)]:
        with pytest.raises(ValueError):
            cli.resource_limits(*values)


def test_loopback_plan_binds_resource_limits_without_an_external_step(monkeypatch):
    cli = load_cli()
    monkeypatch.setattr(cli, "preflight_result", lambda: {"status": "passed"})
    monkeypatch.setattr(
        cli,
        "source_identity",
        lambda: {"repository": "canonical", "release_tag": f"v{cli.VERSION}", "commit": "a" * 40, "tree": "b" * 40},
    )
    monkeypatch.setattr(cli, "application_digest", lambda: "c" * 64)
    monkeypatch.setattr(cli, "target_fingerprint", lambda: "d" * 64)
    args = SimpleNamespace(
        access="loopback",
        bind_address="127.0.0.1",
        hostname="",
        allow_http_private=False,
        memory_mib=384,
        swap_mib=192,
        cpu_millicores=500,
        pids_limit=128,
        profile_id="example-company",
        legal_name="Example Company Ltd.",
        display_name="Example Company",
        brand_mark="EX",
        currency="CNY",
        admin_username="admin",
        timezone="Asia/Shanghai",
        candidate_core_image=None,
        candidate_image=None,
        port=18481,
    )
    plan = cli.make_plan(args)
    assert plan["instance"]["access"] == "loopback"
    assert plan["instance"]["cookie_secure"] is False
    assert plan["instance"]["resource_limits"] == {
        "memory_mib": 384,
        "swap_mib": 192,
        "cpu_millicores": 500,
        "pids_limit": 128,
    }
    assert plan["external_steps"] == []
    assert plan["plan_hash"] == cli.plan_hash(plan)


def test_start_container_applies_the_exact_planned_resource_limits(monkeypatch):
    cli = load_cli()
    commands = []
    monkeypatch.setattr(cli, "container_exists", lambda: False)
    monkeypatch.setattr(cli, "run", lambda command, **_: commands.append(command) or SimpleNamespace(returncode=0))
    plan = {
        "instance": {
            "bind_address": "127.0.0.1",
            "port": 18481,
            "cookie_secure": False,
            "resource_limits": {"memory_mib": 384, "swap_mib": 192, "cpu_millicores": 500, "pids_limit": 128},
        }
    }
    cli.start_container(plan, "sha256:" + "d" * 64)
    command = commands[-1]
    assert command[command.index("--memory") + 1] == str(384 * 1024 * 1024)
    assert command[command.index("--memory-swap") + 1] == str(576 * 1024 * 1024)
    assert command[command.index("--cpus") + 1] == "0.5"
    assert command[command.index("--pids-limit") + 1] == "128"
    assert command[command.index("-p") + 1] == "127.0.0.1:18481:8080"


def test_container_resource_readback_detects_drift(monkeypatch):
    cli = load_cli()
    instance = {"resource_limits": {"memory_mib": 384, "swap_mib": 192, "cpu_millicores": 500, "pids_limit": 128}}
    effective = {
        "cgroup_version": 2,
        "cgroup_path": "/system.slice/docker-test.scope",
        "memory_max_bytes": 384 * 1024 * 1024,
        "memory_swap_max_bytes": 192 * 1024 * 1024,
        "cpu_quota": 50000,
        "cpu_period": 100000,
        "pids_max": 128,
        "raw": {
            "memory.max": str(384 * 1024 * 1024),
            "memory.swap.max": str(192 * 1024 * 1024),
            "cpu.max": "50000 100000",
            "pids.max": "128",
        },
    }
    monkeypatch.setattr(cli, "effective_cgroup_resources", lambda _container: effective)
    monkeypatch.setattr(
        cli,
        "inspect_container",
        lambda: {
            "State": {"Pid": 1234},
            "HostConfig": {
                "Memory": 384 * 1024 * 1024,
                "MemorySwap": 576 * 1024 * 1024,
                "NanoCpus": 500_000_000,
                "PidsLimit": 128,
            }
        },
    )
    assert cli.container_resource_status(instance)["status"] == "ok"
    unlimited_swap = {**effective, "memory_swap_max_bytes": None, "raw": {**effective["raw"], "memory.swap.max": "max"}}
    monkeypatch.setattr(
        cli,
        "effective_cgroup_resources",
        lambda _container: (_ for _ in ()).throw(RuntimeError("effective cgroup value memory.swap.max is unlimited")),
    )
    result = cli.container_resource_status(instance)
    assert result["status"] == "drift"
    assert "memory.swap.max is unlimited" in result["reason"]
    monkeypatch.setattr(cli, "effective_cgroup_resources", lambda _container: unlimited_swap)
    assert cli.container_resource_status(instance)["status"] == "drift"
    monkeypatch.setattr(
        cli,
        "inspect_container",
        lambda: {"HostConfig": {"Memory": 0, "MemorySwap": 0, "NanoCpus": 0, "PidsLimit": 0}},
    )
    assert cli.container_resource_status(instance)["status"] == "drift"
    with pytest.raises(RuntimeError, match="differ from the approved plan"):
        cli.require_container_resources(instance)


def test_legacy_state_without_resource_limits_is_visible_as_drift(monkeypatch):
    cli = load_cli()
    monkeypatch.setattr(
        cli,
        "effective_cgroup_resources",
        lambda _container: (_ for _ in ()).throw(RuntimeError("should not be trusted")),
    )
    monkeypatch.setattr(
        cli,
        "inspect_container",
        lambda: {"HostConfig": {"Memory": 0, "MemorySwap": 0, "NanoCpus": 0, "PidsLimit": 0}},
    )
    status = cli.container_resource_status({})
    assert status["status"] == "drift"
    assert status["expected"] is None
    assert "memory limit" in status["reason"] or "should not be trusted" in status["reason"]


def test_effective_cgroup_v2_values_are_read_from_the_kernel(monkeypatch, tmp_path):
    cli = load_cli()
    group = tmp_path / "system.slice" / "docker-test.scope"
    group.mkdir(parents=True)
    (group / "memory.max").write_text(str(1024 * 1024 * 1024), encoding="utf-8")
    (group / "memory.swap.max").write_text(str(512 * 1024 * 1024), encoding="utf-8")
    (group / "cpu.max").write_text("100000 100000", encoding="utf-8")
    (group / "pids.max").write_text("256", encoding="utf-8")
    monkeypatch.setattr(cli, "CGROUP_ROOT", tmp_path)
    monkeypatch.setattr(cli, "_bounded_cgroup_path", lambda _container: group)
    observed = cli.effective_cgroup_resources({"State": {"Pid": 42}})
    assert observed["memory_max_bytes"] == 1024 * 1024 * 1024
    assert observed["memory_swap_max_bytes"] == 512 * 1024 * 1024
    assert observed["cpu_quota"] == observed["cpu_period"] == 100000
    assert observed["pids_max"] == 256

    (group / "memory.swap.max").write_text("max", encoding="utf-8")
    with pytest.raises(RuntimeError, match="memory.swap.max is unlimited"):
        cli.effective_cgroup_resources({"State": {"Pid": 42}})


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
