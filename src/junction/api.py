import asyncio
import logging
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import Field
from starlette.concurrency import run_in_threadpool

from . import __version__
from .errors import Problem
from .models import Model, Provider, context_schema
from .parsers.common import strict_json
from .store import MAX_CHUNK_CHARS, MAX_IMPORT_BYTES, Store

log = logging.getLogger("junction")
bearer = HTTPBearer(auto_error=False)


class GrantRequest(Model):
    include_raw: bool = Field(default=False, strict=True)


def current_user(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> str:
    if credentials is None:
        raise Problem(401, "unauthorized", "A valid bearer token is required.")
    return request.app.state.store.authenticate(credentials.credentials)


def create_app(data_dir: str | Path) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.store = Store(data_dir)
        app.state.import_slot = asyncio.Semaphore(1)
        yield

    app = FastAPI(
        title="Junction",
        version=__version__,
        lifespan=lifespan,
        description="Immutable context snapshots, paginated reads and explicit per-version sharing.",
    )

    @app.middleware("http")
    async def response_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(Problem)
    async def problem_handler(request: Request, exc: Problem):
        return JSONResponse(
            status_code=exc.status,
            content={"error": {"code": exc.code, "detail": exc.detail}},
            headers={"WWW-Authenticate": "Bearer"} if exc.status == 401 else None,
        )

    @app.exception_handler(sqlite3.OperationalError)
    async def sqlite_handler(request: Request, exc: sqlite3.OperationalError):
        log.error("SQLite operation failed: %s", type(exc).__name__)
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "code": "storage_unavailable",
                    "detail": "Storage is unavailable; retry or inspect the local service.",
                }
            },
            headers={"Retry-After": "2"},
        )

    @app.get("/healthz", tags=["service"])
    def health():
        with app.state.store.connection() as db:
            db.execute("SELECT 1").fetchone()
        return {"status": "ok", "version": __version__}

    @app.get("/v1/schema", tags=["service"])
    def schema():
        return context_schema()

    @app.get("/v1/me", tags=["service"])
    def me(user: str = Depends(current_user)):
        return {"user_id": user}

    @app.post("/v1/imports", tags=["contexts"])
    async def import_context(
        request: Request,
        provider: Provider,
        context_id: str | None = None,
        source_key: str | None = Query(None, max_length=256),
        title: str | None = Query(None, max_length=200),
        source_name: str = Query("upload.jsonl", max_length=1024),
        extensions: str | None = Query(None, max_length=8192),
        shared: bool = False,
        user: str = Depends(current_user),
    ):
        """Upload a byte-for-byte JSONL snapshot. No server-side path or URL imports."""
        try:
            metadata = strict_json(extensions) if extensions is not None else None
        except (ValueError, RecursionError):
            raise Problem(400, "invalid_extensions", "Extensions must be a JSON object.") from None
        if extensions is not None and not isinstance(metadata, dict):
            raise Problem(400, "invalid_extensions", "Extensions must be a JSON object.")
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip()
        if content_type not in {"application/x-ndjson", "application/jsonl", "application/octet-stream"}:
            raise Problem(415, "unsupported_media_type", "Send the JSONL bytes as application/x-ndjson.")
        length = request.headers.get("content-length")
        if length:
            try:
                size = int(length)
                if size < 0:
                    raise ValueError
            except ValueError:
                raise Problem(400, "invalid_length", "Invalid Content-Length.") from None
            if size > MAX_IMPORT_BYTES:
                raise Problem(413, "input_too_large", "A snapshot may contain at most 32 MiB.")
        async with app.state.import_slot:
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_IMPORT_BYTES:
                    raise Problem(413, "input_too_large", "A snapshot may contain at most 32 MiB.")
                body.extend(chunk)
            result = await run_in_threadpool(
                app.state.store.import_bytes,
                user,
                bytes(body),
                provider,
                source_name=source_name,
                context_id=context_id,
                source_key=source_key,
                title=title,
                extensions=metadata,
                shared=shared,
            )
        return JSONResponse(result, status_code=200 if result["reused"] else 201)

    @app.get("/v1/contexts", tags=["contexts"])
    def contexts(
        limit: int = Query(20, ge=1, le=100), cursor: str | None = None,
        shared_only: bool = False, user: str = Depends(current_user)
    ):
        return app.state.store.list_contexts(user, limit=limit, cursor=cursor, shared_only=shared_only)

    @app.get("/v1/contexts/{context_id}", tags=["contexts"])
    def context(context_id: str, user: str = Depends(current_user)):
        """Latest revision visible to the caller. Pin its id for subsequent reads."""
        return app.state.store.get_context(user, context_id)

    prefix = "/v1/contexts/{context_id}/revisions"

    @app.get(prefix, tags=["revisions"])
    def revisions(
        context_id: str,
        limit: int = Query(20, ge=1, le=100),
        cursor: str | None = None,
        shared_only: bool = False,
        user: str = Depends(current_user),
    ):
        return app.state.store.list_revisions(user, context_id, limit=limit, cursor=cursor, shared_only=shared_only)

    revision_path = prefix + "/{revision_id}"

    @app.get(revision_path, tags=["revisions"])
    def revision(context_id: str, revision_id: str, user: str = Depends(current_user)):
        return app.state.store.get_context(user, context_id, revision_id)

    @app.get(revision_path + "/turns", tags=["read"])
    def turns(
        context_id: str,
        revision_id: str,
        limit: int = Query(20, ge=1, le=100),
        cursor: str | None = None,
        user: str = Depends(current_user),
    ):
        return app.state.store.read_page(user, context_id, revision_id, "turns", limit=limit, cursor=cursor)

    @app.get(revision_path + "/messages", tags=["read"])
    def messages(
        context_id: str,
        revision_id: str,
        view: Literal["conversation", "trace"] = "trace",
        turn_id: str | None = None,
        tail_turns: int | None = Query(None, ge=1, le=100),
        limit: int = Query(20, ge=1, le=50),
        cursor: str | None = None,
        user: str = Depends(current_user),
    ):
        return app.state.store.read_page(
            user,
            context_id,
            revision_id,
            "messages",
            limit=limit,
            cursor=cursor,
            view=view,
            turn_id=turn_id,
            tail_turns=tail_turns,
        )

    @app.get(revision_path + "/diagnostics", tags=["read"])
    def diagnostics(
        context_id: str,
        revision_id: str,
        limit: int = Query(20, ge=1, le=100),
        cursor: str | None = None,
        user: str = Depends(current_user),
    ):
        return app.state.store.read_page(
            user, context_id, revision_id, "diagnostics", limit=limit, cursor=cursor
        )

    @app.get(revision_path + "/messages/{message_id}/content", tags=["read"])
    def content(
        context_id: str,
        revision_id: str,
        message_id: str,
        offset: int = Query(0, ge=0),
        limit: int = Query(MAX_CHUNK_CHARS, ge=1, le=MAX_CHUNK_CHARS),
        user: str = Depends(current_user),
    ):
        """Concatenate text chunks and JSON-decode the result to recover the complete block array."""
        return app.state.store.content_chunk(
            user, context_id, revision_id, message_id, offset=offset, limit=limit
        )

    @app.get(revision_path + "/raw", tags=["read"])
    def raw(context_id: str, revision_id: str, user: str = Depends(current_user)):
        data, sha = app.state.store.read_raw(user, context_id, revision_id)
        return Response(
            data,
            media_type="application/x-ndjson",
            headers={
                "ETag": '"' + sha + '"',
                "Content-Disposition": f'attachment; filename="{revision_id}.jsonl"',
            },
        )

    @app.put(revision_path + "/publication", tags=["sharing"])
    def publish(context_id: str, revision_id: str, user: str = Depends(current_user)):
        return app.state.store.set_publication(user, context_id, revision_id)

    @app.delete(revision_path + "/publication", status_code=204, tags=["sharing"])
    def unpublish(context_id: str, revision_id: str, user: str = Depends(current_user)):
        app.state.store.set_publication(user, context_id, revision_id, shared=False)
        return Response(status_code=204)

    @app.get(revision_path + "/grants", tags=["sharing"])
    def grants(context_id: str, revision_id: str, user: str = Depends(current_user)):
        return app.state.store.grants(user, context_id, revision_id)

    @app.put(revision_path + "/grants/{recipient}", tags=["sharing"])
    def share(
        context_id: str,
        revision_id: str,
        recipient: str,
        grant: GrantRequest,
        user: str = Depends(current_user),
    ):
        return app.state.store.set_grant(user, context_id, revision_id, recipient, grant.include_raw)

    @app.delete(revision_path + "/grants/{recipient}", status_code=204, tags=["sharing"])
    def revoke(context_id: str, revision_id: str, recipient: str, user: str = Depends(current_user)):
        app.state.store.revoke(user, context_id, revision_id, recipient)
        return Response(status_code=204)

    return app
