"""Exercise the Compose wrapper with an isolated mock CLI, never a daemon.

Every invocation runs a copied script in a temporary project. The PATH contains
only controlled tools; neither the real project .env nor Docker is reachable.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


PROJECT = Path(__file__).resolve().parents[2]


@dataclass
class ComposeProject:
    directory: Path
    caller: Path
    binary_directory: Path
    script: Path
    log: Path
    env: dict[str, str]
    bash: str
    dotenv: bytes

    def git_calls(self) -> list[list[str]]:
        log = Path(self.env["MOCK_GIT_LOG"])
        return [json.loads(line)["argv"] for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []

    def events(self) -> list[dict]:
        log = Path(self.env["MOCK_EVENT_LOG"])
        return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()] if log.exists() else []

    def run(self, *args: str, stdin: str = "", **overrides: str) -> subprocess.CompletedProcess:
        result = subprocess.run(
            [self.bash, str(self.script), *args], cwd=self.caller,
            env={**self.env, **overrides}, input=stdin, text=True,
            capture_output=True, timeout=15,
        )
        assert (self.directory / ".env").read_bytes() == self.dotenv
        assert not (self.directory / "dotenv-was-executed").exists()
        assert not (self.directory / "backticks-were-executed").exists()
        assert "synthetic-password-not-for-deployment" not in result.stdout + result.stderr
        assert self.env["ADMIN_PASSWORD_HASH"] not in result.stdout + result.stderr
        return result

    def calls(self) -> list[dict]:
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()] if self.log.exists() else []

    def operations(self) -> list[list[str]]:
        calls = self.calls()
        probes = [call for call in calls if call["argv"][:2] == ["compose", "version"]]
        assert len(probes) <= 1
        for call in probes:
            assert call["argv"] in (["compose", "version"], ["compose", "version", "--short"])
        operations = [call for call in calls if call not in probes]
        prefix = ["compose", "--project-directory", str(self.directory)]
        for call in calls:
            assert call["cwd"] == str(self.directory)
            assert call["projectName"] == self.env["COMPOSE_PROJECT_NAME"]
            assert call["composeFile"] == self.env["COMPOSE_FILE"]
            assert call["dockerContext"] == self.env["DOCKER_CONTEXT"]
            assert call["passwordHash"] == self.env["ADMIN_PASSWORD_HASH"]
        for call in operations:
            assert call["argv"][:3] == prefix
        return [call["argv"][3:] for call in operations]


@pytest.fixture
def compose_script_project(tmp_path):
    bash = shutil.which("bash")
    dirname = shutil.which("dirname")
    if not bash or not dirname:
        pytest.skip("Bash and dirname are required for the shell wrapper tests.")
    directory = tmp_path / "project with spaces"
    directory.mkdir()
    script = directory / "docker.compose.sh"
    shutil.copyfile(PROJECT / "docker.compose.sh", script)
    (directory / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
    (directory / "docker-compose.override.yml").write_text("services: {}\n", encoding="utf-8")
    dotenv = (
        "ADMIN_PASSWORD='synthetic-password-not-for-deployment'\n"
        "ADMIN_PASSWORD_HASH='literal$scrypt$fixture-only'\n"
        'SHELL_PAYLOAD=$(touch "$PWD/dotenv-was-executed")\n'
        'BACKTICK_PAYLOAD=`touch "$PWD/backticks-were-executed"`\n'
    ).encode()
    (directory / ".env").write_bytes(dotenv)
    caller = tmp_path / "unrelated caller"
    caller.mkdir()
    # An unrelated .env must not be sourced or chosen by the wrapper either.
    (caller / ".env").write_text("ADMIN_PASSWORD=unrelated-caller-only\n", encoding="utf-8")
    binaries = tmp_path / "mock binaries"
    binaries.mkdir()
    (binaries / "dirname").symlink_to(dirname)
    (binaries / "cat").symlink_to(shutil.which("cat"))
    mock = binaries / "docker"
    mock.write_text(
        "#!" + sys.executable + "\n" + '''import json, os, sys
args = sys.argv[1:]
with open(os.environ["MOCK_DOCKER_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": args, "cwd": os.getcwd(),
        "projectName": os.environ.get("COMPOSE_PROJECT_NAME"),
        "composeFile": os.environ.get("COMPOSE_FILE"),
        "dockerContext": os.environ.get("DOCKER_CONTEXT"),
        "passwordHash": os.environ.get("ADMIN_PASSWORD_HASH")}) + "\\n")
with open(os.environ["MOCK_EVENT_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps({"tool": "docker", "argv": args}) + "\\n")
if args[:2] == ["compose", "version"]:
    sys.exit(int(os.environ.get("MOCK_COMPOSE_STATUS", "0")))
if args[-2:] == ["config", "--quiet"]:
    status = int(os.environ.get("MOCK_CONFIG_STATUS", "0"))
    if status:
        # Even config diagnostics can accidentally contain interpolated values.
        print("synthetic-password-not-for-deployment")
        print(os.environ["ADMIN_PASSWORD_HASH"], file=sys.stderr)
    sys.exit(status)
if os.environ.get("MOCK_FAIL_ACTION") in args[3:4]:
    sys.exit(int(os.environ.get("MOCK_ACTION_STATUS", "1")))
if args[3:4] == ["exec"]:
    source = sys.stdin.read()
    compile(source, "<container-health-probe>", "exec")
    if not source.strip():
        sys.exit(90)
''', encoding="utf-8")
    mock.chmod(0o700)
    mock_git = binaries / "git"
    mock_git.write_text(
        "#!" + sys.executable + "\n" + '''import json, os, pathlib, signal, sys
args = sys.argv[1:]
with open(os.environ["MOCK_GIT_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": args, "cwd": os.getcwd()}) + "\\n")
with open(os.environ["MOCK_EVENT_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps({"tool": "git", "argv": args}) + "\\n")
state_path = pathlib.Path(os.environ["MOCK_GIT_STATE"])
state = json.loads(state_path.read_text()) if state_path.exists() else {
    "stash": "" if os.environ.get("MOCK_GIT_NO_OLD_STASH") == "1" else "a" * 40,
    "dirty": os.environ.get("MOCK_GIT_DIRTY_COMPOSE") == "1"}
root = pathlib.Path(os.environ["MOCK_PROJECT_ROOT"])
def save():
    state_path.write_text(json.dumps(state))
if args == ["rev-parse", "--show-toplevel"]:
    print(os.environ.get("MOCK_GIT_ROOT", str(root)))
elif args in (["symbolic-ref", "--quiet", "--short", "HEAD"], ["branch", "--show-current"], ["rev-parse", "--abbrev-ref", "HEAD"]):
    print(os.environ.get("MOCK_GIT_BRANCH", "main"))
elif args == ["remote", "get-url", "origin"]:
    print("https://example.invalid/fixture-only.git")
    sys.exit(int(os.environ.get("MOCK_GIT_ORIGIN_STATUS", "0")))
elif args[:2] == ["diff", "--cached"]:
    sys.exit(1 if os.environ.get("MOCK_GIT_STAGED") == "1" else 0)
elif args == ["diff", "--name-only"]:
    if state["dirty"]:
        print("docker-compose.yml")
    if os.environ.get("MOCK_GIT_DIRTY_OTHER") == "1":
        print("backend/run.py")
elif args[:2] == ["diff", "--quiet"]:
    if args[-2:] == ["--", "docker-compose.yml"]:
        sys.exit(1 if state["dirty"] else 0)
    sys.exit(1 if os.environ.get("MOCK_GIT_DIRTY_OTHER") == "1" else 0)
elif args[:2] == ["status", "--porcelain"]:
    if os.environ.get("MOCK_GIT_DIRTY_OTHER") == "1":
        print(" M backend/run.py")
    if state["dirty"]:
        print(" M docker-compose.yml")
elif args[0:1] == ["rev-parse"] and args[-1:] == ["refs/stash"]:
    if state["stash"]:
        print(state["stash"])
    else:
        sys.exit(1)
elif args[:2] == ["stash", "push"]:
    status = int(os.environ.get("MOCK_GIT_STASH_STATUS", "0"))
    if status:
        sys.exit(status)
    if os.environ.get("MOCK_GIT_NO_NEW_STASH") != "1":
        state["stash"] = "b" * 40
        state["savedCompose"] = (root / "docker-compose.yml").read_text()
        state["dirty"] = False
        (root / "docker-compose.yml").write_text("services: {fixture_after_stash: {}}\\n")
        save()
elif args[:2] == ["pull", "--ff-only"]:
    if os.environ.get("MOCK_GIT_PULL_SIGNAL") in ("INT", "TERM"):
        os.kill(os.getppid(), getattr(signal, "SIG" + os.environ["MOCK_GIT_PULL_SIGNAL"]))
    sys.exit(int(os.environ.get("MOCK_GIT_PULL_STATUS", "0")))
elif args[:2] == ["stash", "apply"]:
    status = int(os.environ.get("MOCK_GIT_APPLY_STATUS", "0"))
    if status:
        sys.exit(status)
    if args[-1] != "b" * 40:
        sys.exit(92)
    (root / "docker-compose.yml").write_text(state["savedCompose"])
    state["dirty"] = True
    save()
else:
    print("Unsupported isolated mock Git invocation: " + repr(args), file=sys.stderr)
    sys.exit(91)
''', encoding="utf-8")
    mock_git.chmod(0o700)
    log = tmp_path / "docker-calls.jsonl"
    env = {
        "PATH": str(binaries), "HOME": str(tmp_path), "LANG": "C.UTF-8",
        "MOCK_DOCKER_LOG": str(log), "COMPOSE_PROJECT_NAME": "existing-storage-project",
        "COMPOSE_FILE": "docker-compose.yml:docker-compose.override.yml",
        "DOCKER_CONTEXT": "isolated-fixture-context",
        "ADMIN_PASSWORD_HASH": "synthetic$environment$hash-only",
        "MOCK_GIT_LOG": str(tmp_path / "git-calls.jsonl"),
        "MOCK_GIT_STATE": str(tmp_path / "git-state.json"),
        "MOCK_EVENT_LOG": str(tmp_path / "all-calls.jsonl"),
        "MOCK_PROJECT_ROOT": str(directory),
    }
    return ComposeProject(directory, caller, binaries, script, log, env, bash, dotenv)


CONFIG = ["config", "--quiet"]
START = ["up", "-d", "--no-build", "--pull", "never", "--force-recreate", "aegis"]
HEALTH = ["exec", "-T", "aegis", "python", "-"]
UP = [CONFIG, ["build", "aegis"], START, HEALTH, ["ps", "--all"]]
RESTART = [CONFIG, START, HEALTH, ["ps", "--all"]]
UPDATE = [CONFIG, *UP]


@pytest.mark.parametrize(("args", "expected"), [
    ([], UPDATE), (["update"], UPDATE), (["up"], UP), (["build"], [CONFIG, ["build", "aegis"]]),
    (["restart"], RESTART), (["stop"], [["stop", "aegis"]]),
    (["down"], [["down"]]), (["logs"], [["logs", "--follow", "--tail", "100", "aegis"]]),
    (["ps"], [["ps", "--all"]]), (["status"], [["ps", "--all"]]),
    (["check"], [CONFIG]), (["config"], [CONFIG]), (["--check"], [CONFIG]),
])
def test_commands_preserve_project_environment_and_use_safe_exact_arguments(compose_script_project, args, expected):
    project = compose_script_project
    assert project.run(*args).returncode == 0
    assert project.operations() == expected
    assert len(project.calls()) == len(expected) + 1


@pytest.mark.parametrize("command", ["help", "--help", "-h"])
def test_help_needs_no_docker_or_dotenv(compose_script_project, command):
    project = compose_script_project
    (project.binary_directory / "docker").unlink()
    (project.directory / ".env").unlink()
    # run() checks .env preservation, so invoke directly for this absent-file case.
    result = subprocess.run([project.bash, str(project.script), command], cwd=project.caller,
                            env=project.env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0 and result.stdout.strip()
    assert project.calls() == []
    assert not (project.directory / ".env").exists()


@pytest.mark.parametrize("args", [
    ["unknown"], ["--build"], ["--project-name", "other"],
    ["up", "--build"], ["down", "-v"], ["down", "--volumes"],
    ["stop", "other"], ["config", "--format", "json"], ["menu", "up"],
    ["help", "up"],
])
def test_invalid_commands_and_extra_flags_fail_before_any_docker_call(compose_script_project, args):
    project = compose_script_project
    assert project.run(*args).returncode != 0
    assert project.calls() == []


@pytest.mark.parametrize("args", [[], ["up"], ["restart"], ["build"]])
def test_failed_config_is_private_preserves_exit_status_and_blocks_mutation(compose_script_project, args):
    project = compose_script_project
    result = project.run(*args, MOCK_CONFIG_STATUS="23")
    assert result.returncode == 23
    assert project.operations() == [CONFIG]


@pytest.mark.parametrize(("command", "action", "expected"), [
    ("up", "up", UP[:3]), ("restart", "up", RESTART[:2]),
    ("up", "build", UP[:2]), ("up", "exec", UP[:4]),
    ("restart", "exec", RESTART[:3]),
    ("build", "build", [CONFIG, ["build", "aegis"]]),
    ("stop", "stop", [["stop", "aegis"]]),
    ("down", "down", [["down"]]), ("ps", "ps", [["ps", "--all"]]),
])
def test_operational_failure_propagates_and_does_not_continue(compose_script_project, command, action, expected):
    project = compose_script_project
    assert project.run(command, MOCK_FAIL_ACTION=action, MOCK_ACTION_STATUS="31").returncode == 31
    assert project.operations() == expected


def test_missing_docker_fails_without_falling_back_to_legacy_compose(compose_script_project):
    project = compose_script_project
    (project.binary_directory / "docker").unlink()
    assert project.run("up").returncode != 0
    assert project.calls() == []


def test_missing_compose_v2_fails_before_config_or_daemon_operations(compose_script_project):
    project = compose_script_project
    assert project.run("up", MOCK_COMPOSE_STATUS="9").returncode != 0
    assert project.operations() == []
    assert len(project.calls()) == 1


@pytest.mark.parametrize(("selection", "expected"), [
    ("1", UP), ("2", RESTART), ("3", [["ps", "--all"]]),
    ("4", [["logs", "--follow", "--tail", "100", "aegis"]]),
    ("5", [CONFIG, ["build", "aegis"]]), ("6", [["stop", "aegis"]]),
    ("7", [["down"]]), ("8", [CONFIG]), ("9", UPDATE),
])
def test_explicit_menu_dispatches_one_selection_without_changing_safety(compose_script_project, selection, expected):
    project = compose_script_project
    assert project.run("menu", stdin=selection + "\n0\n").returncode == 0
    assert project.operations() == expected


@pytest.mark.parametrize("stdin", ["", "0\n", "q\n", "quit\n", "invalid\n0\n"])
def test_menu_eof_exit_and_invalid_input_do_not_start_or_remove_services(compose_script_project, stdin):
    project = compose_script_project
    assert project.run("menu", stdin=stdin).returncode == 0
    assert project.operations() == []


@pytest.mark.parametrize("overrides", [
    {"MOCK_CONFIG_STATUS": "23"},
    {"MOCK_FAIL_ACTION": "up", "MOCK_ACTION_STATUS": "31"},
])
def test_failed_menu_action_does_not_run_following_status_and_can_exit(compose_script_project, overrides):
    project = compose_script_project
    result = project.run("menu", stdin="1\n0\n", **overrides)
    assert result.returncode == 0
    assert project.operations() == ([CONFIG] if "MOCK_CONFIG_STATUS" in overrides else UP[:3])
    assert str(next(value for key, value in overrides.items() if key.endswith("STATUS"))) in result.stderr


def test_clean_update_pulls_without_querying_or_applying_an_old_stash(compose_script_project):
    project = compose_script_project
    assert project.run("update").returncode == 0
    calls = project.git_calls()
    assert ["pull", "--ff-only", "origin", "main"] in calls
    assert not any(call[:1] == ["stash"] or "refs/stash" in call for call in calls)
    assert project.operations() == UPDATE


def test_update_restores_only_its_new_compose_stash_before_building(compose_script_project):
    project = compose_script_project
    compose_before = (project.directory / "docker-compose.yml").read_bytes()
    assert project.run("update", MOCK_GIT_DIRTY_COMPOSE="1").returncode == 0
    calls = project.git_calls()
    push = ["stash", "push", "--quiet", "-m", "keep-aegis-server-compose", "--", "docker-compose.yml"]
    pull = ["pull", "--ff-only", "origin", "main"]
    apply = ["stash", "apply", "b" * 40]
    assert calls.count(push) == calls.count(pull) == calls.count(apply) == 1
    assert calls.index(push) < calls.index(pull) < calls.index(apply)
    assert not any(call[:2] in (["stash", "pop"], ["stash", "drop"]) for call in calls)
    assert (project.directory / "docker-compose.yml").read_bytes() == compose_before
    events = project.events()
    restored = next(index for index, event in enumerate(events) if event == {"tool": "git", "argv": apply})
    build = next(index for index, event in enumerate(events) if event["tool"] == "docker" and event["argv"][3:] == ["build", "aegis"])
    assert restored < build
    assert project.operations() == UPDATE


def test_failed_pull_restores_own_compose_stash_and_preserves_original_exit_code(compose_script_project):
    project = compose_script_project
    compose_before = (project.directory / "docker-compose.yml").read_bytes()
    result = project.run("update", MOCK_GIT_DIRTY_COMPOSE="1", MOCK_GIT_PULL_STATUS="41")
    assert result.returncode == 41
    assert ["stash", "apply", "b" * 40] in project.git_calls()
    assert (project.directory / "docker-compose.yml").read_bytes() == compose_before
    assert project.operations() == [CONFIG]


def test_failed_pull_on_clean_tree_never_applies_existing_stash(compose_script_project):
    project = compose_script_project
    assert project.run("update", MOCK_GIT_PULL_STATUS="41").returncode == 41
    assert not any(call[:1] == ["stash"] or "refs/stash" in call for call in project.git_calls())
    assert project.operations() == [CONFIG]


def test_compose_restore_conflict_aborts_before_build_and_retains_backup(compose_script_project):
    project = compose_script_project
    assert project.run("update", MOCK_GIT_DIRTY_COMPOSE="1", MOCK_GIT_APPLY_STATUS="42").returncode != 0
    calls = project.git_calls()
    applies = [call for call in calls if call[:2] == ["stash", "apply"]]
    assert applies and all(call == ["stash", "apply", "b" * 40] for call in applies)
    assert not any(call[:2] in (["stash", "pop"], ["stash", "drop"]) for call in calls)
    assert project.operations() == [CONFIG]
    assert json.loads(Path(project.env["MOCK_GIT_STATE"]).read_text())["stash"] == "b" * 40


@pytest.mark.parametrize("overrides", [
    {"MOCK_GIT_STASH_STATUS": "43"}, {"MOCK_GIT_NO_NEW_STASH": "1"},
])
def test_failed_or_unconfirmed_stash_blocks_pull_and_never_applies_old_backup(compose_script_project, overrides):
    project = compose_script_project
    assert project.run("update", MOCK_GIT_DIRTY_COMPOSE="1", **overrides).returncode != 0
    calls = project.git_calls()
    assert not any(call[:1] == ["pull"] or call[:2] == ["stash", "apply"] for call in calls)
    assert project.operations() == [CONFIG]


@pytest.mark.parametrize("overrides", [
    {"MOCK_GIT_BRANCH": "feature/local"}, {"MOCK_GIT_ROOT": "/unrelated/check-out"},
    {"MOCK_GIT_ORIGIN_STATUS": "44"}, {"MOCK_GIT_STAGED": "1"},
    {"MOCK_GIT_DIRTY_OTHER": "1"},
])
def test_update_guard_failures_do_not_stash_pull_build_or_replace_services(compose_script_project, overrides):
    project = compose_script_project
    assert project.run("update", **overrides).returncode != 0
    calls = project.git_calls()
    assert not any(call[:1] in (["pull"], ["stash"]) for call in calls)
    assert project.operations() == []


def test_up_does_not_require_git_and_never_pulls_a_checkout(compose_script_project):
    project = compose_script_project
    (project.binary_directory / "git").unlink()
    assert project.run("up").returncode == 0
    assert project.git_calls() == []
    assert project.operations() == UP


def test_first_ever_compose_stash_is_verified_and_restored_by_oid(compose_script_project):
    project = compose_script_project
    assert project.run("update", MOCK_GIT_DIRTY_COMPOSE="1", MOCK_GIT_NO_OLD_STASH="1").returncode == 0
    assert ["stash", "apply", "b" * 40] in project.git_calls()
    assert project.operations() == UPDATE


@pytest.mark.parametrize(("signal", "exit_code"), [("INT", 130), ("TERM", 143)])
def test_interrupted_pull_restores_own_stash_without_build_or_container_changes(compose_script_project, signal, exit_code):
    project = compose_script_project
    compose_before = (project.directory / "docker-compose.yml").read_bytes()
    result = project.run("update", MOCK_GIT_DIRTY_COMPOSE="1", MOCK_GIT_PULL_SIGNAL=signal)
    assert result.returncode == exit_code
    assert ["stash", "apply", "b" * 40] in project.git_calls()
    assert (project.directory / "docker-compose.yml").read_bytes() == compose_before
    assert project.operations() == [CONFIG]


def test_explicit_installation_paths_are_individual_quoted_compose_arguments(compose_script_project):
    project = compose_script_project
    env_file = project.directory / "custom secrets.env"
    env_file.write_bytes(project.dotenv)
    compose_file = project.directory / "server override.yml"
    compose_file.write_text("services: {}\n", encoding="utf-8")
    assert project.run("check", AEGIS_PROJECT="existing-data-name", AEGIS_ENV_FILE=str(env_file),
                       AEGIS_COMPOSE_FILE=str(compose_file)).returncode == 0
    operations = [call["argv"] for call in project.calls() if call["argv"][:2] != ["compose", "version"]]
    assert operations == [["compose", "--project-directory", str(project.directory),
                           "--project-name", "existing-data-name", "--env-file", str(env_file),
                           "--file", str(compose_file), *CONFIG]]
    assert env_file.read_bytes() == project.dotenv


@pytest.fixture
def real_git_project(compose_script_project, tmp_path):
    """Local bare origin and two worktrees; no GitHub, network or user Git config."""
    project = compose_script_project
    git = shutil.which("git")
    if not git:
        pytest.skip("Git is required for local stash/merge integration tests.")
    project.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
                       GIT_TERMINAL_PROMPT="0", GIT_ALLOW_PROTOCOL="file")

    def run_git(*args: str, directory: Path | None = None) -> str:
        result = subprocess.run(
            [git, "-c", "user.name=Compose Test", "-c", "user.email=compose-test@example.invalid", *args],
            cwd=directory or project.directory, env=project.env, text=True,
            capture_output=True, timeout=15,
        )
        assert result.returncode == 0, "Isolated local Git fixture failed: " + result.stderr
        return result.stdout.strip()

    origin = tmp_path / "local origin.git"
    run_git("init", "--bare", "--initial-branch=main", str(origin), directory=tmp_path)
    run_git("init", "--initial-branch=main")
    run_git("config", "user.name", "Compose Test")
    run_git("config", "user.email", "compose-test@example.invalid")
    (project.directory / ".gitignore").write_text(".env\n", encoding="utf-8")
    (project.directory / "docker-compose.yml").write_text(
        "services:\n  aegis:\n    image: fixture:initial\n    ports:\n"
        '      - "127.0.0.1:8787:8787"\n    environment:\n      EXISTING_VALUE: keep-me\n',
        encoding="utf-8",
    )
    run_git("add", ".gitignore", "docker-compose.yml", "docker.compose.sh")
    run_git("commit", "-m", "Isolated initial source")
    run_git("remote", "add", "origin", str(origin))
    run_git("push", "--set-upstream", "origin", "main")
    upstream = tmp_path / "other local checkout"
    run_git("clone", str(origin), str(upstream), directory=tmp_path)

    # Record real script commands but delegate only to this local repository.
    (project.binary_directory / "git").write_text(
        "#!" + sys.executable + "\n" + "import json, os, sys\n"
        "args = sys.argv[1:]\n"
        'with open(os.environ["MOCK_GIT_LOG"], "a", encoding="utf-8") as log:\n'
        '    log.write(json.dumps({"argv": args, "cwd": os.getcwd()}) + "\\n")\n'
        'with open(os.environ["MOCK_EVENT_LOG"], "a", encoding="utf-8") as log:\n'
        '    log.write(json.dumps({"tool": "git", "argv": args}) + "\\n")\n'
        "os.execv(" + repr(git) + ", [" + repr(git) + "] + args)\n",
        encoding="utf-8",
    )
    return project, upstream, run_git


def test_real_git_update_merges_upstream_change_and_restores_local_port(real_git_project):
    project, upstream, git = real_git_project
    remote_compose = upstream / "docker-compose.yml"
    remote_compose.write_text(remote_compose.read_text().replace(
        "EXISTING_VALUE: keep-me", "EXISTING_VALUE: keep-me\n      REMOTE_VALUE: added-upstream"), encoding="utf-8")
    git("add", "docker-compose.yml", directory=upstream)
    git("commit", "-m", "Add upstream model setting", directory=upstream)
    git("push", "origin", "main", directory=upstream)
    compose = project.directory / "docker-compose.yml"
    compose.write_text(compose.read_text().replace("127.0.0.1:8787:8787", "0.0.0.0:8787:8787"), encoding="utf-8")
    assert project.run("update").returncode == 0
    assert '"0.0.0.0:8787:8787"' in compose.read_text()
    assert "REMOTE_VALUE: added-upstream" in compose.read_text()
    stash = git("rev-parse", "refs/stash")
    assert ["stash", "apply", stash] in project.git_calls()
    assert git("status", "--porcelain", "--untracked-files=no") == "M docker-compose.yml"
    assert project.operations() == UPDATE


def test_real_git_clean_update_keeps_preexisting_stash_unapplied(real_git_project):
    project, _, git = real_git_project
    compose = project.directory / "docker-compose.yml"
    original = compose.read_bytes()
    compose.write_text(compose.read_text().replace("127.0.0.1:8787:8787", "192.0.2.1:8787:8787"), encoding="utf-8")
    git("stash", "push", "-m", "Earlier unrelated saved ports", "--", "docker-compose.yml")
    before_stash = git("rev-parse", "refs/stash")
    assert project.run("update").returncode == 0
    assert compose.read_bytes() == original
    assert git("rev-parse", "refs/stash") == before_stash
    assert not any(call[:1] == ["stash"] or "refs/stash" in call for call in project.git_calls())
    assert project.operations() == UPDATE


def test_real_git_diverged_pull_restores_local_port_without_replacing_container(real_git_project):
    project, upstream, git = real_git_project
    (project.directory / "local-code.txt").write_text("local-only commit\n", encoding="utf-8")
    git("add", "local-code.txt")
    git("commit", "-m", "Local divergent commit")
    local_head = git("rev-parse", "HEAD")
    (upstream / "remote-code.txt").write_text("remote-only commit\n", encoding="utf-8")
    git("add", "remote-code.txt", directory=upstream)
    git("commit", "-m", "Remote divergent commit", directory=upstream)
    git("push", "origin", "main", directory=upstream)
    compose = project.directory / "docker-compose.yml"
    compose.write_text(compose.read_text().replace("127.0.0.1:8787:8787", "0.0.0.0:8787:8787"), encoding="utf-8")
    expected = compose.read_bytes()
    result = project.run("update")
    assert result.returncode != 0
    assert compose.read_bytes() == expected and git("rev-parse", "HEAD") == local_head
    stash = git("rev-parse", "refs/stash")
    assert ["stash", "apply", stash] in project.git_calls()
    assert project.operations() == [CONFIG]


def test_real_git_update_does_not_execute_new_script_tail_after_self_replacement(real_git_project):
    project, upstream, git = real_git_project
    script = upstream / "docker.compose.sh"
    appended = '\nprintf "unexpected tail execution\\n" > "$PWD/updated-script-tail-ran"\n'
    script.write_text(script.read_text() + appended, encoding="utf-8")
    git("add", "docker.compose.sh", directory=upstream)
    git("commit", "-m", "Replace the running script during update", directory=upstream)
    git("push", "origin", "main", directory=upstream)
    assert project.run("update").returncode == 0
    assert project.script.read_text().endswith(appended)
    assert not (project.directory / "updated-script-tail-ran").exists()
    assert project.operations() == UPDATE
