"""Isolated browser-test server, never imported by the production application.

The parent supplies a new temporary directory and synthetic credentials. This
entrypoint intentionally does not use backend/run.py or load a project .env.
The socket stays bound between port allocation and Uvicorn startup.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import sys
import time

import uvicorn

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "backend"))

from aegis.auth import hash_password
from aegis.main import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    directory = args.directory.resolve(strict=True)
    offset_path, ready_path = directory / "clock-offset.txt", directory / "ready.json"

    def clock():
        return time.time() + float(offset_path.read_text(encoding="utf-8"))

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        port = listener.getsockname()[1]
        base_url = f"http://127.0.0.1:{port}"
        app = create_app({
            "ADMIN_USER": os.environ["AEGIS_BROWSER_TEST_USERNAME"],
            "ADMIN_PASSWORD": "", "ADMIN_PASSWORD_HASH": hash_password(os.environ["AEGIS_BROWSER_TEST_PASSWORD"]),
            "AEGIS_ADMIN_TOKEN": "", "AEGIS_ROLE_MAP": "",
            "AEGIS_DATABASE_PATH": str(directory / "fixture.sqlite"),
            "AEGIS_FRONTEND_PATH": str(PROJECT / "dist" / "python-client"),
            "AEGIS_EVALUATION_WORKER_ENABLED": "false", "AEGIS_EVALUATION_WORKER_TOKEN": "",
            "AEGIS_TRUST_PROXY_IDENTITY": "false", "AEGIS_TRUSTED_PROXY_IPS": "",
            "AEGIS_REQUIRE_ADMIN_IDENTITY": "true", "PUBLIC_BASE_URL": base_url,
            "AEGIS_ALLOWED_HOSTS": "127.0.0.1", "AEGIS_ALLOW_PRIVATE_UPSTREAM": "false",
            "AEGIS_SESSION_IDLE_SECONDS": "60", "AEGIS_SESSION_MAX_SECONDS": "3600",
            "AEGIS_LOGIN_WINDOW_SECONDS": "10", "AEGIS_LOGIN_ACCOUNT_LIMIT": "3",
            "AEGIS_LOGIN_IP_LIMIT": "5", "AEGIS_LOGIN_GLOBAL_LIMIT": "10", "_auth_clock": clock,
        })
        ready = directory / "ready.tmp"
        ready.write_text(json.dumps({"baseUrl": base_url, "pid": os.getpid()}), encoding="utf-8")
        ready.replace(ready_path)
        try:
            uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False, proxy_headers=False)).run(sockets=[listener])
        finally:
            ready_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
