"""Server configuration. Secrets are never serialized into console state."""
from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
ROOT = PROJECT_ROOT


def load_env_file(path: Path | None = None) -> None:
    """Load a simple local .env without executing shell syntax or overriding env."""
    path = path or PROJECT_ROOT / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if not key or not key.replace("_", "").isalnum() or key[0].isdigit():
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def settings(overrides: dict | None = None) -> dict:
    env = dict(os.environ)
    if overrides:
        env.update(overrides)
    env.setdefault("AEGIS_DATABASE_PATH", str(PROJECT_ROOT / "data" / "aegis.sqlite"))
    env.setdefault("AEGIS_FRONTEND_PATH", str(PROJECT_ROOT / "dist" / "python-client"))
    return env


def validate_bind(env: dict, host: str) -> None:
    user = env.get("ADMIN_USER", "")
    password = env.get("ADMIN_PASSWORD_HASH", "") or env.get("ADMIN_PASSWORD", "")
    if bool(user) != bool(password):
        raise RuntimeError("ADMIN_USER와 ADMIN_PASSWORD 또는 ADMIN_PASSWORD_HASH를 함께 설정하세요.")
    if host not in {"127.0.0.1", "::1", "localhost"} and not (user and password):
        raise RuntimeError("외부 주소에 바인딩하려면 관리자 계정을 설정하세요.")
