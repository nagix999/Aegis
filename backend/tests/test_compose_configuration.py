"""Render the real Compose configuration without a daemon or user credentials."""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def compose_project(tmp_path):
    docker = shutil.which("docker")
    if docker is None:
        pytest.skip("Docker CLI is unavailable; Compose rendering was not checked.")
    home = tmp_path / "home"
    home.mkdir()
    docker_config = tmp_path / "docker-config"
    docker_config.mkdir()
    # An allowlist prevents developer ADMIN/AEGIS/VLLM/COMPOSE/DOCKER settings,
    # credentials and Docker context configuration from entering this process.
    env = {"PATH": os.environ.get("PATH", os.defpath), "HOME": str(home),
           "DOCKER_CONFIG": str(docker_config)}
    version = subprocess.run([docker, "compose", "version"], cwd=tmp_path, env=env,
                             capture_output=True, text=True, timeout=15)
    if version.returncode:
        pytest.skip("Docker Compose CLI is unavailable in the isolated environment; rendering was not checked.")
    # Resolve the repository's current file in an isolated project so Compose
    # cannot discover the real project .env, even when defaults change later.
    compose_file = tmp_path / "docker-compose.yml"
    shutil.copyfile(PROJECT_ROOT / "docker-compose.yml", compose_file)
    # Explicit --env-file must supersede automatic .env discovery.
    (tmp_path / ".env").write_text("ADMIN_PASSWORD=wrong-test-default\nAEGIS_ROLE_MAP=wrong-test-default\n", encoding="utf-8")
    return docker, tmp_path, compose_file, env


@pytest.mark.parametrize("explicit", [False, True], ids=["defaults", "explicit-settings"])
def test_compose_explicit_identity_environment_and_safe_defaults(compose_project, explicit):
    docker, project, compose_file, env = compose_project
    expected = {
        "AEGIS_ROLE_MAP": "", "AEGIS_ADMIN_TOKEN": "",
        "AEGIS_TRUST_PROXY_IDENTITY": "false", "AEGIS_TRUSTED_PROXY_IPS": "",
        "AEGIS_REQUIRE_ADMIN_IDENTITY": "false",
        "ADMIN_PASSWORD_HASH": "", "AEGIS_ALLOWED_HOSTS": "",
        "AEGIS_SESSION_IDLE_SECONDS": "1800", "AEGIS_SESSION_MAX_SECONDS": "43200",
        "AEGIS_LOGIN_WINDOW_SECONDS": "300", "AEGIS_LOGIN_ACCOUNT_LIMIT": "10",
        "AEGIS_LOGIN_IP_LIMIT": "20", "AEGIS_LOGIN_GLOBAL_LIMIT": "100",
    }
    values = {"ADMIN_PASSWORD": "test-compose-password-only", "UNRELATED_TEST_SETTING": "must-not-be-forwarded"}
    if explicit:
        expected.update({
            "AEGIS_ROLE_MAP": '{"admin":"viewer","proxy-editor":"editor"}',
            "AEGIS_ADMIN_TOKEN": "test-compose-admin-token-only",
            "AEGIS_TRUST_PROXY_IDENTITY": "true",
            "AEGIS_TRUSTED_PROXY_IPS": "192.0.2.10,192.0.2.11",
            "AEGIS_REQUIRE_ADMIN_IDENTITY": "true",
            "ADMIN_PASSWORD_HASH": "test-compose-hash-only$literal$not-a-real-hash",
            "AEGIS_ALLOWED_HOSTS": "console.example,localhost",
            "AEGIS_SESSION_IDLE_SECONDS": "900", "AEGIS_SESSION_MAX_SECONDS": "7200",
            "AEGIS_LOGIN_WINDOW_SECONDS": "120", "AEGIS_LOGIN_ACCOUNT_LIMIT": "5",
            "AEGIS_LOGIN_IP_LIMIT": "12", "AEGIS_LOGIN_GLOBAL_LIMIT": "80",
        })
        values.update(expected)
    env_file = project / "test.env"
    env_file.write_text("".join(f"{key}='{value}'\n" for key, value in values.items()), encoding="utf-8")
    rendered = subprocess.run([
        docker, "compose", "--project-directory", str(project), "--env-file", str(env_file),
        "-f", str(compose_file), "config", "--format", "json",
    ], cwd=project, env=env, capture_output=True, text=True, timeout=15)
    assert rendered.returncode == 0, "docker compose config failed in the isolated test project."
    container_env = json.loads(rendered.stdout)["services"]["aegis"]["environment"]
    # `config` serializes literal dollars as $$ so the emitted configuration
    # can be passed back to Compose without another interpolation.
    rendered_expected = {key: value.replace("$", "$$") for key, value in expected.items()}
    assert {key: container_env.get(key) for key in expected} == rendered_expected
    assert container_env["ADMIN_USER"] == "admin"
    assert container_env["ADMIN_PASSWORD"] == values["ADMIN_PASSWORD"]
    assert "UNRELATED_TEST_SETTING" not in container_env
    assert "HOME" not in container_env
    assert "DOCKER_CONFIG" not in container_env


@pytest.mark.parametrize("password", [None, ""], ids=["missing-password", "empty-password"])
def test_compose_without_password_or_hash_is_rejected_by_python_launcher(compose_project, password):
    docker, project, compose_file, env = compose_project
    env_file = project / "test.env"
    # The fixture's automatic .env has a password; the explicit env-file must
    # still leave both credentials empty. Runtime validation supports either
    # a plaintext password or a hash; Compose alone cannot express that OR.
    env_file.write_text("# ADMIN_PASSWORD is absent\n" if password is None else "ADMIN_PASSWORD=''\n", encoding="utf-8")
    rendered = subprocess.run([
        docker, "compose", "--project-directory", str(project), "--env-file", str(env_file),
        "-f", str(compose_file), "config", "--format", "json",
    ], cwd=project, env=env, capture_output=True, text=True, timeout=15)
    assert rendered.returncode == 0
    container_env = json.loads(rendered.stdout)["services"]["aegis"]["environment"]
    assert not container_env["ADMIN_PASSWORD"]
    assert not container_env["ADMIN_PASSWORD_HASH"]
    from aegis.config import validate_bind
    with pytest.raises(RuntimeError, match="ADMIN_PASSWORD"):
        validate_bind(container_env, container_env["HOST"])


def test_compose_hash_only_authentication_preserves_literal_dollar_and_allows_bind(compose_project):
    docker, project, compose_file, env = compose_project
    from aegis.auth import hash_password
    from aegis.config import validate_bind
    # Generated entirely from a fake test password; no user environment read.
    encoded = hash_password("compose-test-only-password")
    env_file = project / "hash.env"
    env_file.write_text("ADMIN_PASSWORD_HASH='" + encoded + "'\n", encoding="utf-8")
    rendered = subprocess.run([
        docker, "compose", "--project-directory", str(project), "--env-file", str(env_file),
        "-f", str(compose_file), "config", "--format", "json",
    ], cwd=project, env=env, capture_output=True, text=True, timeout=15)
    assert rendered.returncode == 0, "Hash-only Compose rendering failed."
    container_env = json.loads(rendered.stdout)["services"]["aegis"]["environment"]
    assert container_env["ADMIN_PASSWORD"] == ""
    assert container_env["ADMIN_PASSWORD_HASH"] == encoded.replace("$", "$$")
    validate_bind(container_env, container_env["HOST"])
