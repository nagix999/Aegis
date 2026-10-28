"""Portable browser fixtures using new SQLite databases and owned processes."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time

import httpx
import pytest

PROJECT = Path(__file__).resolve().parents[2]


def pytest_addoption(parser):
    group = parser.getgroup("aegis-browser")
    group.addoption("--browser-executable", help="Optional local Chromium/Chrome executable; CI uses Playwright Chromium.")
    group.addoption("--browser-artifacts", default="test-results/auth", help="Screenshots, traces and server logs on failure.")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    result = yield
    report = result.get_result()
    setattr(item, "browser_report_" + report.when, report)


def failed(node) -> bool:
    return bool(getattr(node, "browser_diagnostic_failure", False)) or any(
        getattr(getattr(node, "browser_report_" + stage, None), "failed", False) for stage in ("setup", "call")
    )


@pytest.fixture(scope="session")
def browser_artifact_root(pytestconfig):
    root = Path(pytestconfig.getoption("--browser-artifacts")).resolve()
    # A fresh directory avoids stale failures being mistaken for this run.
    run = root / (time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + "-" + secrets.token_hex(4))
    run.mkdir(parents=True, exist_ok=False)
    return run


@pytest.fixture
def browser_artifact_dir(browser_artifact_root, request):
    name = request.node.name
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)[:100]
    identity = hashlib.sha256(request.node.nodeid.encode()).hexdigest()[:8]
    directory = browser_artifact_root / (safe_name + "-" + identity)
    directory.mkdir()
    return directory


@dataclass
class ConsoleServer:
    base_url: str
    username: str
    password: str
    root: Path
    process: subprocess.Popen
    offset: float = 0

    def advance(self, seconds: float):
        if seconds < 0:
            raise ValueError("The fixture clock may only advance.")
        self.offset += seconds
        temporary = self.root / "clock-offset.tmp"
        temporary.write_text(str(self.offset), encoding="utf-8")
        temporary.replace(self.root / "clock-offset.txt")


def server_environment(username: str, password: str) -> dict[str, str]:
    # Do not inherit ADMIN/AEGIS/VLLM/proxy settings, tokens or project .env.
    allowed = ("PATH", "SYSTEMROOT", "WINDIR", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "LANG", "LC_ALL")
    env = {name: os.environ[name] for name in allowed if name in os.environ}
    env.update(PYTHONUTF8="1", PYTHONUNBUFFERED="1", PYTHONDONTWRITEBYTECODE="1",
               AEGIS_BROWSER_TEST_USERNAME=username, AEGIS_BROWSER_TEST_PASSWORD=password)
    return env


@pytest.fixture
def console_server(tmp_path, request, browser_artifact_dir):
    index = PROJECT / "dist" / "python-client" / "index.html"
    if not index.is_file():
        pytest.fail("Build the Python UI first: pnpm build:python-ui", pytrace=False)
    root = tmp_path / "console"
    root.mkdir()
    (root / "clock-offset.txt").write_text("0", encoding="utf-8")
    username, password = "browser-test-admin", secrets.token_urlsafe(24)
    log_path = root / "server.log"
    process = None
    try:
        with log_path.open("wb") as log:
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("server.py")), "--directory", str(root)],
                                       cwd=root, env=server_environment(username, password), stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 20
        ready_path, info = root / "ready.json", None
        with httpx.Client(trust_env=False, timeout=1) as client:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    pytest.fail("Temporary console server exited; see the failure server.log artifact.", pytrace=False)
                if ready_path.is_file():
                    info = json.loads(ready_path.read_text(encoding="utf-8"))
                    try:
                        response = client.get(info["baseUrl"] + "/healthz")
                        if response.status_code == 200 and response.json().get("backend") == "python-fastapi":
                            break
                    except httpx.HTTPError:
                        pass
                time.sleep(.05)
            else:
                pytest.fail("Temporary console server did not become ready within 20s.", pytrace=False)
        assert info and info["pid"] == process.pid
        yield ConsoleServer(info["baseUrl"], username, password, root, process)
    finally:
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if process.returncode not in (0, -15, 143) or failed(request.node):
                shutil.copyfile(log_path, browser_artifact_dir / "server.log")


@pytest.fixture(scope="session")
def playwright():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        pytest.fail("Install browser test dependencies: python -m pip install -r backend/requirements-browser.txt", pytrace=False)
    with sync_playwright() as instance:
        yield instance


@pytest.fixture(scope="session")
def browser(playwright, pytestconfig):
    # Browser children do not need administrator, model or proxy environment
    # settings either. Playwright always creates a separate temporary profile.
    allowed = ("PATH", "SYSTEMROOT", "WINDIR", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "LANG", "LC_ALL", "XDG_RUNTIME_DIR")
    options = {"headless": True, "env": {name: os.environ[name] for name in allowed if name in os.environ}}
    executable = pytestconfig.getoption("--browser-executable")
    if executable:
        options["executable_path"] = str(Path(executable).expanduser().resolve())
    try:
        instance = playwright.chromium.launch(**options)
    except Exception as error:
        pytest.fail("Chromium is required (no skip). Run python -m playwright install chromium, or pass --browser-executable. " + str(error), pytrace=False)
    try:
        yield instance
    finally:
        instance.close()


@pytest.fixture
def context(browser, console_server, request, browser_artifact_dir):
    instance = browser.new_context(base_url=console_server.base_url, viewport={"width": 1450, "height": 1000})
    errors = []
    instance.on("page", lambda page: page.on("pageerror", lambda error: errors.append(str(error))))
    instance.set_default_timeout(12000)
    tracing_started = False
    try:
        instance.tracing.start(screenshots=True, snapshots=True, sources=False)
        tracing_started = True
        yield instance
    finally:
        retain = failed(request.node) or bool(errors)
        if retain:
            request.node.browser_diagnostic_failure = True
        try:
            if retain:
                for i, page in enumerate(instance.pages):
                    if not page.is_closed():
                        try:
                            page.screenshot(path=str(browser_artifact_dir / f"page-{i}.png"), full_page=True, timeout=5000)
                        except Exception:
                            pass
                (browser_artifact_dir / "browser-errors.log").write_text("\n".join(errors), encoding="utf-8")
            if tracing_started:
                instance.tracing.stop(path=str(browser_artifact_dir / "trace.zip") if retain else None)
        finally:
            instance.close()
        if errors:
            pytest.fail("Unexpected browser JavaScript exception(s): " + "; ".join(errors), pytrace=False)


@pytest.fixture
def page(context):
    return context.new_page()
