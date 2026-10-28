"""Single-administrator browser sessions and existing machine authentication.

Session/attempt state is private SQLite state, outside the console records. Raw
session tokens, passwords and submitted account names are never persisted.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import math
import secrets
import threading
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import Request

from .errors import ApiError

COOKIE_NAME = "aegis_session"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
PASSWORD_N, PASSWORD_R, PASSWORD_P = 16384, 8, 5


def hash_password(password: str) -> str:
    """Produce a versioned, bounded stdlib scrypt hash for ADMIN_PASSWORD_HASH."""
    if not isinstance(password, str) or not 1 <= len(password) <= 1024:
        raise ValueError("비밀번호는 1~1024자로 입력하세요.")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=PASSWORD_N, r=PASSWORD_R, p=PASSWORD_P, dklen=32)
    return "$".join(("scrypt", str(PASSWORD_N), str(PASSWORD_R), str(PASSWORD_P),
                     base64.b64encode(salt).decode(), base64.b64encode(digest).decode()))


def _password_hash_parts(value: str) -> tuple[bytes, bytes]:
    try:
        scheme, n, r, p, salt, digest = value.split("$")
        if (scheme, n, r, p) != ("scrypt", str(PASSWORD_N), str(PASSWORD_R), str(PASSWORD_P)):
            raise ValueError
        salt, digest = base64.b64decode(salt, validate=True), base64.b64decode(digest, validate=True)
        if len(salt) != 16 or len(digest) != 32:
            raise ValueError
        return salt, digest
    except (ValueError, TypeError):
        raise ValueError("ADMIN_PASSWORD_HASH 형식을 확인하세요. python -m aegis.password_hash로 생성하세요.") from None


def password_matches(password: str, env: dict) -> bool:
    encoded = str(env.get("ADMIN_PASSWORD_HASH", ""))
    if encoded:
        salt, expected = _password_hash_parts(encoded)
        actual = hashlib.scrypt(password.encode(), salt=salt, n=PASSWORD_N, r=PASSWORD_R, p=PASSWORD_P, dklen=32)
        return hmac.compare_digest(actual, expected)
    expected = str(env.get("ADMIN_PASSWORD", ""))
    return bool(expected) and hmac.compare_digest(password.encode(), expected.encode())


def trusted_proxy(request: Request, env: dict) -> bool:
    if str(env.get("AEGIS_TRUST_PROXY_IDENTITY", "false")).lower() != "true":
        return False
    allowed = env.get("AEGIS_TRUSTED_PROXY_IPS", [])
    if isinstance(allowed, str):
        allowed = [item.strip() for item in allowed.split(",") if item.strip()]
    return bool(request.client and request.client.host in allowed)


def client_ip(request: Request, env: dict) -> str:
    if trusted_proxy(request, env):
        value = request.headers.get("cf-connecting-ip") or request.headers.get("x-real-ip")
        if value:
            return value[:128]
    return (request.client.host if request.client else "unknown").removeprefix("::ffff:")


def check_origin(request: Request, env: dict, *, required: bool = False) -> None:
    if request.method in SAFE_METHODS:
        return
    origin = request.headers.get("origin")
    expected = str(env.get("PUBLIC_BASE_URL", "")).rstrip("/") or str(request.base_url).rstrip("/")
    if (required and not origin) or origin is not None and origin != expected:
        raise ApiError("이 관리 화면과 다른 주소에서 보낸 변경 요청은 허용하지 않습니다.", "origin_not_allowed", 403)


def check_host(request: Request, env: dict) -> None:
    """Opt-in host restriction, also derived from the configured public URL."""
    configured = env.get("AEGIS_ALLOWED_HOSTS", "")
    if isinstance(configured, str):
        configured = [item.strip().lower().rstrip(".") for item in configured.split(",") if item.strip()]
    if not configured and env.get("PUBLIC_BASE_URL"):
        hostname = urlsplit(str(env["PUBLIC_BASE_URL"])).hostname
        configured = [hostname.lower().rstrip(".")] if hostname else []
    if configured:
        hostname = (request.url.hostname or "").lower().rstrip(".")
        if hostname not in configured:
            raise ApiError("허용되지 않은 서버 주소입니다.", "host_not_allowed", 400)


def _integer(env: dict, name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(env.get(name, default))
    except (ValueError, TypeError):
        raise RuntimeError(f"{name} 설정을 확인하세요.") from None
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name}은 {minimum}~{maximum} 범위로 설정하세요.")
    return value


class AuthService:
    def __init__(self, store, env: dict):
        self.store, self.env = store, env
        self._password_slots = threading.BoundedSemaphore(4)
        if env.get("ADMIN_PASSWORD_HASH"):
            _password_hash_parts(str(env["ADMIN_PASSWORD_HASH"]))
        self.idle = _integer(env, "AEGIS_SESSION_IDLE_SECONDS", 1800, 60, 86400)
        self.maximum = _integer(env, "AEGIS_SESSION_MAX_SECONDS", 43200, 60, 604800)
        self.idle = min(self.idle, self.maximum)
        self.window = _integer(env, "AEGIS_LOGIN_WINDOW_SECONDS", 300, 1, 3600)
        self.limits = {"account": _integer(env, "AEGIS_LOGIN_ACCOUNT_LIMIT", 10, 1, 10000),
                       "ip": _integer(env, "AEGIS_LOGIN_IP_LIMIT", 20, 1, 10000),
                       "global": _integer(env, "AEGIS_LOGIN_GLOBAL_LIMIT", 100, 1, 10000)}
        with store._transaction():
            store.db.execute("INSERT OR IGNORE INTO aegis_auth_meta(name,value) VALUES('secret',?)", (secrets.token_hex(32),))
            self.secret = bytes.fromhex(store.db.execute("SELECT value FROM aegis_auth_meta WHERE name='secret'").fetchone()[0])

    def clock(self) -> float:
        return float(self.env.get("_auth_clock", time.time)())

    def login_available(self) -> bool:
        return bool(self.env.get("ADMIN_USER") and (self.env.get("ADMIN_PASSWORD_HASH") or self.env.get("ADMIN_PASSWORD")))

    async def password_task(self, function, *args):
        # Do not queue an unbounded number of expensive KDFs, or block the loop.
        if not self._password_slots.acquire(blocking=False):
            error = ApiError("로그인 요청을 처리 중입니다. 잠시 후 다시 시도하세요.", "login_rate_limited", 429)
            error.retry_after = 1
            raise error

        def run():
            try:
                return function(*args)
            finally:
                self._password_slots.release()

        # A disconnected caller must not release admission while its KDF is
        # still running, or cancel a queued task before it releases the slot.
        return await asyncio.shield(asyncio.create_task(asyncio.to_thread(run)))

    def fingerprint(self) -> str:
        value = json.dumps([str(self.env.get(name, "")) for name in ("ADMIN_USER", "ADMIN_PASSWORD_HASH", "ADMIN_PASSWORD")], separators=(",", ":"))
        return hmac.new(self.secret, value.encode(), hashlib.sha256).hexdigest()

    def audit(self, action: str, *, identity: str = "anonymous", detail: str = "") -> None:
        timestamp = datetime.fromtimestamp(self.clock(), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        event = {"id": str(uuid.uuid4()), "actor": identity, "action": action, "target": "console-auth", "createdAt": timestamp, "detail": detail}
        with self.store.lock:
            self.store._put("audit", event["id"], event, timestamp)

    def _scopes(self, request: Request) -> list[tuple[str, int]]:
        return [(kind + ":" + hashlib.sha256(value.encode()).hexdigest(), self.limits[kind]) for kind, value in
                (("account", str(self.env.get("ADMIN_USER", ""))), ("ip", client_ip(request, self.env)), ("global", "all"))]

    def reserve_attempt(self, request: Request) -> None:
        """Reserve before password hashing; cross-process counters and bounded wait."""
        now = self.clock()
        denied = 0
        with self.store._transaction():
            self.store.db.execute("DELETE FROM aegis_auth_attempts WHERE window_start<=?", (now - self.window,))
            rows = []
            for scope, limit in self._scopes(request):
                row = self.store.db.execute("SELECT window_start,attempts FROM aegis_auth_attempts WHERE scope=?", (scope,)).fetchone()
                rows.append((scope, row))
                if row and row["attempts"] >= limit:
                    denied = max(denied, math.ceil(row["window_start"] + self.window - now))
            if not denied:
                # Bound cardinality even when a trusted edge supplies many IPs.
                if self.store.db.execute("SELECT COUNT(*) FROM aegis_auth_attempts").fetchone()[0] >= 8192:
                    denied = self.window
                else:
                    for scope, row in rows:
                        self.store.db.execute("INSERT INTO aegis_auth_attempts VALUES(?,?,1) ON CONFLICT(scope) DO UPDATE SET attempts=attempts+1", (scope, now))
        if denied:
            # Emit at most one throttle event per application window, not per request.
            with self.store._transaction():
                previous = self.store.db.execute("SELECT value FROM aegis_auth_meta WHERE name='throttle_audit'").fetchone()
                if not previous or float(previous[0]) <= now - self.window:
                    self.store.db.execute("INSERT INTO aegis_auth_meta VALUES('throttle_audit',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value", (str(now),))
                    self.audit("admin_login_throttled", detail="인증 재시도 제한")
            error = ApiError("로그인 시도가 많습니다. 잠시 후 다시 시도하세요.", "login_rate_limited", 429)
            error.retry_after = max(1, denied)
            raise error

    def _verify(self, username: str, password: str) -> bool:
        # Always verify the password, even for a different submitted account name.
        password_ok = password_matches(password, self.env)
        return self.login_available() and hmac.compare_digest(username.encode(), str(self.env.get("ADMIN_USER", "")).encode()) and password_ok

    def verify_login(self, request: Request, username: str, password: str) -> str:
        self.reserve_attempt(request)
        if not self._verify(username, password):
            self.audit("admin_login_failed", detail="인증 실패")
            raise ApiError("관리자 계정과 비밀번호를 확인하세요.", "unauthorized", 401)
        with self.store._transaction():
            self.store.db.executemany("DELETE FROM aegis_auth_attempts WHERE scope=?", [(scope,) for scope, _ in self._scopes(request) if not scope.startswith("global:")])
            self.store.db.execute("UPDATE aegis_auth_attempts SET attempts=max(0,attempts-1) WHERE scope=?", (self._scopes(request)[-1][0],))
        return str(self.env["ADMIN_USER"])

    @staticmethod
    def token_hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def csrf(self, token_hash: str) -> str:
        return hmac.new(self.secret, ("csrf:" + token_hash).encode(), hashlib.sha256).hexdigest()

    def session(self, request: Request) -> dict | None:
        token = request.cookies.get(COOKIE_NAME, "")
        if not token or len(token) > 128:
            return None
        hashed, now = self.token_hash(token), self.clock()
        with self.store._transaction():
            row = self.store.db.execute("SELECT * FROM aegis_admin_sessions WHERE token_hash=?", (hashed,)).fetchone()
            if not row:
                return None
            if row["expires_at"] <= now or row["last_seen"] + self.idle <= now or not hmac.compare_digest(row["credential_fingerprint"], self.fingerprint()) or not self.login_available():
                self.store.db.execute("DELETE FROM aegis_admin_sessions WHERE token_hash=?", (hashed,))
                return None
        return {"identity": row["identity"], "method": "session", "tokenHash": hashed,
                "_absoluteExpires": row["expires_at"], "csrfToken": self.csrf(hashed),
                "expiresAt": datetime.fromtimestamp(min(row["expires_at"], row["last_seen"] + self.idle), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}

    def authenticate(self, request: Request) -> dict:
        cached = getattr(request.state, "admin_auth", None)
        if cached:
            return cached
        authorization = request.headers.get("authorization", "")
        token = str(self.env.get("AEGIS_ADMIN_TOKEN", ""))
        result = None
        if token and (hmac.compare_digest(authorization.encode(), f"Bearer {token}".encode()) or hmac.compare_digest(request.headers.get("x-aegis-admin-token", "").encode(), token.encode())):
            result = {"identity": "service-admin", "method": "token"}
        elif authorization.startswith("Basic "):
            try:
                decoded = base64.b64decode(authorization[6:], validate=True).decode()
                user, password = decoded.split(":", 1)
                if len(user) > 128 or len(password) > 1024:
                    raise ValueError
            except (ValueError, UnicodeDecodeError):
                self.reserve_attempt(request)
                self.audit("admin_login_failed", detail="인증 실패")
                raise ApiError("관리자 인증이 필요합니다.", "unauthorized", 401) from None
            result = {"identity": self.verify_login(request, user, password), "method": "basic"}
        else:
            result = self.session(request)
        if not result and trusted_proxy(request, self.env):
            identity = request.headers.get("oai-authenticated-user-id", "").strip()
            if identity:
                result = {"identity": identity, "method": "proxy"}
        if not result:
            local = bool(request.client and request.client.host in {"127.0.0.1", "::1", "localhost"})
            no_credentials = not any(self.env.get(key) for key in ("ADMIN_USER", "ADMIN_PASSWORD", "ADMIN_PASSWORD_HASH", "AEGIS_ADMIN_TOKEN"))
            if local and no_credentials and str(self.env.get("AEGIS_REQUIRE_ADMIN_IDENTITY", "false")).lower() != "true":
                result = {"identity": "local-admin", "method": "development"}
        if not result:
            raise ApiError("관리자 인증이 필요합니다.", "unauthorized", 401)
        check_origin(request, self.env, required=result["method"] == "session")
        if result["method"] == "session":
            provided = request.headers.get("x-aegis-csrf", "")
            csrf_ok = hmac.compare_digest(provided.encode(), result["csrfToken"].encode())
            if request.method not in SAFE_METHODS and not csrf_ok:
                raise ApiError("화면의 인증 상태를 새로 확인한 뒤 다시 시도하세요.", "csrf_failed", 403)
            # Background GET polling must not renew idle expiry. The activity
            # header is a UI hint, authenticated by the existing CSRF secret;
            # it is not a proof of human activity or an absolute-expiry bypass.
            renew = request.method not in SAFE_METHODS or request.headers.get("x-aegis-activity") == "1" and csrf_ok
            if renew:
                now = self.clock()
                with self.store.lock:
                    updated = self.store.db.execute("UPDATE aegis_admin_sessions SET last_seen=? WHERE token_hash=? AND credential_fingerprint=? AND expires_at>? AND last_seen>?",
                                                    (now, result["tokenHash"], self.fingerprint(), now, now - self.idle))
                if not updated.rowcount:
                    raise ApiError("관리자 인증이 필요합니다.", "unauthorized", 401)
                result["expiresAt"] = datetime.fromtimestamp(min(result["_absoluteExpires"], now + self.idle), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        request.state.admin_auth = result
        return result

    def status(self, auth: dict | None = None) -> dict:
        result = {"authenticated": bool(auth), "loginAvailable": self.login_available(), "authMethod": auth["method"] if auth else None}
        if auth:
            result["identity"] = auth["identity"]
            for key in ("csrfToken", "expiresAt"):
                if key in auth:
                    result[key] = auth[key]
        return result

    def login(self, request: Request, username: str, password: str) -> tuple[str, dict]:
        identity = self.verify_login(request, username, password)
        token, now = secrets.token_urlsafe(32), self.clock()
        hashed = self.token_hash(token)
        with self.store._transaction():
            self.store.db.execute("DELETE FROM aegis_admin_sessions WHERE expires_at<=? OR last_seen<=? OR credential_fingerprint!=?", (now, now - self.idle, self.fingerprint()))
            self.revoke(request)
            self.store.db.execute("INSERT INTO aegis_admin_sessions VALUES(?,?,?,?,?,?)", (hashed, identity, self.fingerprint(), now, now, now + self.maximum))
            self.store.db.execute("DELETE FROM aegis_admin_sessions WHERE identity=? AND token_hash NOT IN (SELECT token_hash FROM aegis_admin_sessions WHERE identity=? ORDER BY created_at DESC LIMIT 20)", (identity, identity))
        self.audit("admin_login", identity=identity, detail="로그인")
        return token, self.status({"identity": identity, "method": "session", "csrfToken": self.csrf(hashed), "expiresAt": datetime.fromtimestamp(now + self.idle, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")})

    def revoke(self, request: Request) -> None:
        token = request.cookies.get(COOKIE_NAME, "")
        if token and len(token) <= 128:
            with self.store.lock:
                self.store.db.execute("DELETE FROM aegis_admin_sessions WHERE token_hash=?", (self.token_hash(token),))

    def cookie_secure(self, request: Request) -> bool:
        return request.url.scheme == "https" or urlsplit(str(self.env.get("PUBLIC_BASE_URL", ""))).scheme == "https"
