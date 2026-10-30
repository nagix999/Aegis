"""FastAPI application serving the unchanged React console and Python backend."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path
import re

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.openapi.utils import get_openapi
from fastapi.responses import FileResponse, JSONResponse

from .config import settings
from .errors import ApiError
from .auth import AuthService, COOKIE_NAME, check_host, check_origin
from .review import ENGINE_VERSION
from .upstream_transport import upstream_client


def create_app(overrides: dict | None = None, *, store=None) -> FastAPI:
    from .store import Store
    from .api import admin_allowed, create_router, read_body
    from .worker import run_worker

    env = settings(overrides)
    owned_store = store is None
    storage = store if store is not None else Store(env["AEGIS_DATABASE_PATH"], env=env)
    env["_store"] = storage
    frontend = Path(env["AEGIS_FRONTEND_PATH"]).resolve()
    auth = AuthService(storage, env)
    env["_auth_service"] = auth
    # Freeze the public build filenames at startup. Only Vite's content-hashed
    # assets and the known favicon are needed to render the login shell.
    public_assets = set()
    assets_dir = frontend / "assets"
    if not assets_dir.is_symlink():
        for asset in assets_dir.glob("*"):
            if (not asset.is_symlink() and asset.is_file() and asset.resolve().is_relative_to(frontend)
                    and re.fullmatch(r"[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css|svg|png|jpg|jpeg|webp|gif|woff|woff2|ttf|ico)", asset.name)):
                public_assets.add("/assets/" + asset.name)
    favicon = frontend / "favicon.svg"
    if not favicon.is_symlink() and favicon.is_file():
        public_assets.add("/favicon.svg")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await storage.seed()
        stop = asyncio.Event()
        async with upstream_client(env) as client:
            env.setdefault("_client", client)
            worker = None
            if str(env.get("AEGIS_EVALUATION_WORKER_ENABLED", "true")).lower() == "true":
                worker = asyncio.create_task(run_worker(storage, env, stop), name="aegis-evaluation-worker")
                await asyncio.sleep(0)
            try:
                yield
            finally:
                stop.set()
                if worker:
                    try:
                        await asyncio.wait_for(asyncio.shield(worker), timeout=5)
                    except (TimeoutError, asyncio.CancelledError):
                        worker.cancel()
                        with suppress(asyncio.CancelledError):
                            await worker
                env.pop("_client", None)
                if owned_store:
                    await storage.close()

    app = FastAPI(title="Aegis Gateway API", version="3.9.0", lifespan=lifespan,
                  description="요청 검사와 응답 검사, 워크플로우 검증 및 OpenAI 형식 Gateway")
    app.state.store, app.state.env = storage, env
    app.state.auth_service = auth

    def public_auth_error(error: ApiError, request: Request | None = None):
        headers = {"Cache-Control": "no-store"}
        if error.status == 429:
            headers["Retry-After"] = str(getattr(error, "retry_after", 60))
        if error.status == 401 and request is not None and request.headers.get("authorization", "").startswith("Basic "):
            headers["WWW-Authenticate"] = 'Basic realm="Aegis administrator", charset="UTF-8"'
        return JSONResponse({"error": {"message": error.message, "code": error.code}}, status_code=error.status, headers=headers)

    @app.exception_handler(ApiError)
    async def public_error(_request: Request, error: ApiError):
        return public_auth_error(error)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, _error: RequestValidationError):
        return JSONResponse({"error": {"message": "입력값을 확인하세요.", "code": "invalid_request"}}, status_code=400)

    @app.exception_handler(Exception)
    async def unexpected_error(_request: Request, _error: Exception):
        # Starlette generates unhandled 500 responses outside HTTP middleware.
        return JSONResponse({"error": {"message": "요청을 처리하지 못했습니다. 관리자에게 서버 상태 확인을 요청하세요.", "code": "server_error"}}, status_code=500,
                            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY"})

    @app.middleware("http")
    async def protect_console(request: Request, call_next):
        path = request.url.path
        # The login shell and explicit built assets contain no console state.
        exempt = path.startswith("/v1/") or path in {"/healthz", "/api/evaluations/worker", "/api/auth/session", "/api/auth/login", "/api/auth/logout", "/", "/index.html"} or path in public_assets
        try:
            check_host(request, env)
            if not exempt:
                if request.headers.get("authorization", "").startswith("Basic "):
                    await auth.password_task(admin_allowed, request, env)
                else:
                    admin_allowed(request, env)
            response = await call_next(request)
        except ApiError as error:
            response = public_auth_error(error, request)
        response.headers.setdefault("Cache-Control", "no-store")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    auth_response_schema = {"type": "object", "required": ["authenticated", "loginAvailable", "authMethod"], "properties": {
        "authenticated": {"type": "boolean"}, "loginAvailable": {"type": "boolean"},
        "authMethod": {"type": ["string", "null"], "enum": ["session", "basic", "token", "proxy", "development", None]},
        "identity": {"type": "string"}, "csrfToken": {"type": "string"}, "expiresAt": {"type": "string", "format": "date-time"}}}

    @app.get("/api/auth/session", tags=["Authentication"], operation_id="console_session", responses={200: {"content": {"application/json": {"schema": auth_response_schema}}}})
    async def session_status(request: Request):
        try:
            if request.headers.get("authorization", "").startswith("Basic "):
                await auth.password_task(admin_allowed, request, env)
            else:
                admin_allowed(request, env)
            result = auth.status(request.state.admin_auth)
        except ApiError as error:
            if error.status != 401 or request.headers.get("authorization", "").startswith("Basic "):
                return public_auth_error(error, request)
            result = auth.status()
        response = JSONResponse(result)
        if not result["authenticated"] and request.cookies.get(COOKIE_NAME):
            response.delete_cookie(COOKIE_NAME, path="/", httponly=True, secure=auth.cookie_secure(request), samesite="lax")
        return response

    @app.post("/api/auth/login", tags=["Authentication"], operation_id="console_login", openapi_extra={"requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["username", "password"], "additionalProperties": False, "properties": {"username": {"type": "string", "maxLength": 128}, "password": {"type": "string", "maxLength": 1024, "writeOnly": True}}}}}}}, responses={200: {"content": {"application/json": {"schema": auth_response_schema}}}})
    async def login(request: Request):
        try:
            check_origin(request, env, required=True)
            data = await read_body(request, 8192)
            if set(data) != {"username", "password"} or not isinstance(data["username"], str) or not isinstance(data["password"], str) or not 1 <= len(data["username"]) <= 128 or not 1 <= len(data["password"]) <= 1024:
                raise ApiError("관리자 계정과 비밀번호를 입력하세요.")
            token, status = await auth.password_task(auth.login, request, data["username"], data["password"])
            response = JSONResponse(status)
            response.set_cookie(COOKIE_NAME, token, max_age=auth.maximum, httponly=True, secure=auth.cookie_secure(request), samesite="lax", path="/")
            return response
        except ApiError as error:
            return public_auth_error(error)

    @app.post("/api/auth/logout", tags=["Authentication"], operation_id="console_logout", responses={200: {"content": {"application/json": {"schema": auth_response_schema}}}})
    async def logout(request: Request):
        try:
            if request.headers.get("authorization", "").startswith("Basic "):
                await auth.password_task(admin_allowed, request, env)
            else:
                admin_allowed(request, env)
            identity = request.state.admin_auth["identity"]
            auth.revoke(request)
            auth.audit("admin_logout", identity=identity, detail="로그아웃")
            response = JSONResponse(auth.status())
            response.delete_cookie(COOKIE_NAME, path="/", httponly=True, secure=auth.cookie_secure(request), samesite="lax")
            return response
        except ApiError as error:
            response = public_auth_error(error)
            if error.status == 401:
                response.delete_cookie(COOKIE_NAME, path="/", httponly=True, secure=auth.cookie_secure(request), samesite="lax")
            return response

    @app.get("/healthz", include_in_schema=False)
    async def health():
        return {"status": "ok", "backend": "python-fastapi", "engineVersion": ENGINE_VERSION}

    app.include_router(create_router(storage, env))

    def openapi_contract():
        if app.openapi_schema is not None:
            return app.openapi_schema
        from . import schemas
        document = get_openapi(title=app.title, version=app.version, description=app.description, routes=app.routes)
        components = document.setdefault("components", {})
        models = components.setdefault("schemas", {})
        for name in ("Workflow", "PolicyDefinition", "Connection", "Dataset", "KeyPolicy", "RetentionPolicy", "GenerationSettings", "Conversation"):
            model = getattr(schemas, name).model_json_schema(ref_template="#/components/schemas/{model}")
            models.update(model.pop("$defs", {}))
            models[name] = model
        components["securitySchemes"] = {
            "ConsoleBasic": {"type": "http", "scheme": "basic"},
            "AdminToken": {"type": "apiKey", "in": "header", "name": "x-aegis-admin-token"},
            "ConsoleSession": {"type": "apiKey", "in": "cookie", "name": COOKIE_NAME},
            "SessionCSRF": {"type": "apiKey", "in": "header", "name": "X-Aegis-CSRF"},
            "GatewayBearer": {"type": "http", "scheme": "bearer", "bearerFormat": "ag_..."},
            "WorkerBearer": {"type": "http", "scheme": "bearer"},
        }
        for path, methods in document.get("paths", {}).items():
            scheme = "GatewayBearer" if path.startswith("/v1/") else "WorkerBearer" if path == "/api/evaluations/worker" else "ConsoleBasic"
            for method, operation in methods.items():
                if method not in {"get", "post", "put", "delete", "patch", "options", "head"}:
                    continue
                if path in {"/api/auth/session", "/api/auth/login"}:
                    operation["security"] = []
                    continue
                operation["security"] = [{scheme: []}]
                if scheme == "ConsoleBasic":
                    operation["security"].append({"AdminToken": []})
                    session_security = {"ConsoleSession": []}
                    if method not in {"get", "head", "options"}:
                        session_security["SessionCSRF"] = []
                    operation["security"].append(session_security)
        app.openapi_schema = document
        return document

    app.openapi = openapi_contract

    @app.get("/{path:path}", include_in_schema=False)
    async def console(path: str):
        if path.startswith(("api/", "v1/")):
            raise ApiError("API 경로를 찾을 수 없습니다.", "not_found", 404)
        requested = frontend / path
        target = requested.resolve()
        if (any(part.startswith(".") for part in Path(path).parts) or not target.is_relative_to(frontend)
                or any(part.is_symlink() for part in [requested, *requested.parents] if part != frontend and part.is_relative_to(frontend))):
            raise ApiError("파일을 찾을 수 없습니다.", "not_found", 404)
        if not path or not target.is_file():
            index = frontend / "index.html"
            target = index.resolve()
            if index.is_symlink() or not target.is_relative_to(frontend):
                raise ApiError("파일을 찾을 수 없습니다.", "not_found", 404)
        if not target.is_file():
            raise ApiError("관리 화면을 빌드한 뒤 서버를 실행하세요.", "frontend_not_built", 503)
        return FileResponse(target)

    return app
