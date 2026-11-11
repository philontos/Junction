"""Transactional catalog and immutable archives. No provider paths are followed."""

import base64
import hashlib
import json
import os
import re
import secrets
import sqlite3
import tempfile
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .errors import Problem, not_found
from .models import PARSER_VERSION, NormalizedContext
from .overview import OVERVIEW_EXTENSION, build_overview
from .parsers import normalize
from .parsers.common import json_text

MAX_IMPORT_BYTES = 32 * 1024 * 1024
MAX_INLINE_CHARS = 4096
MAX_CHUNK_CHARS = 16384
DB_VERSION = 3

DDL = """
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contexts (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
 id TEXT PRIMARY KEY, context_id TEXT NOT NULL REFERENCES contexts(id), number INTEGER NOT NULL,
 provider TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_bytes INTEGER NOT NULL,
 source_name TEXT NOT NULL, parser_version TEXT NOT NULL, status TEXT NOT NULL,
 created_at TEXT NOT NULL, header_json TEXT NOT NULL, message_count INTEGER NOT NULL,
 turn_count INTEGER NOT NULL, diagnostic_count INTEGER NOT NULL,
 UNIQUE(context_id, number), UNIQUE(context_id, provider, source_sha256, parser_version)
);
CREATE INDEX IF NOT EXISTS revisions_context ON revisions(context_id, number DESC);
CREATE INDEX IF NOT EXISTS revisions_source ON revisions(provider, source_sha256, parser_version);
CREATE TABLE IF NOT EXISTS turns (
 revision_id TEXT NOT NULL REFERENCES revisions(id), sequence INTEGER NOT NULL,
 id TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(revision_id, sequence), UNIQUE(revision_id,id)
);
CREATE TABLE IF NOT EXISTS messages (
 revision_id TEXT NOT NULL REFERENCES revisions(id), sequence INTEGER NOT NULL,
 id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL, is_meta INTEGER NOT NULL,
 data_json TEXT NOT NULL, content_json TEXT NOT NULL,
 PRIMARY KEY(revision_id, sequence), UNIQUE(revision_id,id),
 FOREIGN KEY(revision_id,turn_id) REFERENCES turns(revision_id,id)
);
CREATE INDEX IF NOT EXISTS messages_turn ON messages(revision_id,turn_id,sequence);
CREATE TABLE IF NOT EXISTS diagnostics (
 revision_id TEXT NOT NULL REFERENCES revisions(id), sequence INTEGER NOT NULL,
 data_json TEXT NOT NULL, PRIMARY KEY(revision_id,sequence)
);
CREATE TABLE IF NOT EXISTS grants (
 revision_id TEXT NOT NULL REFERENCES revisions(id), user_id TEXT NOT NULL REFERENCES users(id),
 include_raw INTEGER NOT NULL CHECK(include_raw IN (0,1)), created_at TEXT NOT NULL,
 PRIMARY KEY(revision_id,user_id)
);
CREATE TABLE IF NOT EXISTS publications (
 revision_id TEXT PRIMARY KEY REFERENCES revisions(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revision_overviews (
 revision_id TEXT PRIMARY KEY REFERENCES revisions(id), data_json TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def encode_cursor(scope: str, position: int) -> str:
    return base64.urlsafe_b64encode(json_text([scope, position]).encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None, scope: str, default: int = 0) -> int:
    if cursor is None:
        return default
    try:
        if len(cursor) > 2048:
            raise ValueError
        value = json.loads(base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True))
        if (
            not isinstance(value, list)
            or len(value) != 2
            or value[0] != scope
            or type(value[1]) is not int
            or not 0 <= value[1] <= 2**63 - 1
        ):
            raise ValueError
        return value[1]
    except (ValueError, UnicodeError):
        raise Problem(400, "invalid_cursor", "Cursor does not match this query.") from None


def sync_directory(path: Path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Store:
    def __init__(self, data_dir: str | Path):
        self.root = Path(data_dir).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.raw_dir = self.root / "raw"
        self.raw_dir.mkdir(exist_ok=True, mode=0o700)
        self.db_path = self.root / "junction.sqlite3"
        db = sqlite3.connect(self.db_path, timeout=15, isolation_level=None)
        try:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1, 2, DB_VERSION):
                raise RuntimeError(f"Unsupported database version {version}; refusing to modify it.")
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA foreign_keys=ON")
            db.executescript("BEGIN IMMEDIATE;\n" + DDL + f"\nPRAGMA user_version={DB_VERSION};\nCOMMIT;")
        finally:
            db.close()
        self.db_path.chmod(0o600)

    @contextmanager
    def connection(self, *, write: bool = False):
        db = sqlite3.connect(self.db_path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=15000")
        db.execute("PRAGMA synchronous=FULL")
        try:
            # A read transaction keeps authorization and the corresponding result consistent.
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def add_user(self, user: str, token: str, *, rotate: bool = False):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", user):
            raise Problem(400, "invalid_user", "Use 1–64 letters, numbers, dots, underscores or hyphens.")
        with self.connection(write=True) as db:
            exists = db.execute("SELECT 1 FROM users WHERE id=?", (user,)).fetchone()
            if exists and not rotate:
                raise Problem(409, "user_exists", "User already exists; use --rotate with a new token file.")
            if rotate and not exists:
                raise not_found()
            if exists:
                db.execute("UPDATE users SET token_hash=? WHERE id=?", (digest(token.encode()), user))
            else:
                db.execute("INSERT INTO users VALUES (?,?,?)", (user, digest(token.encode()), now()))

    def authenticate(self, token: str) -> str:
        if not 20 <= len(token) <= 256:
            raise Problem(401, "unauthorized", "A valid bearer token is required.")
        with self.connection() as db:
            row = db.execute("SELECT id FROM users WHERE token_hash=?", (digest(token.encode()),)).fetchone()
        if row is None:
            raise Problem(401, "unauthorized", "A valid bearer token is required.")
        return row["id"]

    def raw_path(self, sha: str) -> Path:
        if not re.fullmatch("[0-9a-f]{64}", sha):
            raise Problem(500, "archive_corrupt", "Archive reference is invalid.")
        return self.raw_dir / sha[:2] / (sha + ".jsonl")

    def archive(self, raw: bytes, sha: str):
        path = self.raw_path(sha)
        path.parent.mkdir(exist_ok=True, mode=0o700)
        if path.exists():
            self.verified_raw(sha)
            return
        fd, temp = tempfile.mkstemp(prefix=".upload-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
            sync_directory(path.parent)
            sync_directory(self.raw_dir)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

    def verified_raw(self, sha: str) -> bytes:
        try:
            data = self.raw_path(sha).read_bytes()
        except FileNotFoundError:
            raise Problem(
                500, "archive_missing", "Original archive is missing; restore it from backup."
            ) from None
        if digest(data) != sha:
            raise Problem(500, "archive_corrupt", "Original archive checksum does not match.")
        return data

    def import_bytes(
        self,
        user: str,
        raw: bytes,
        provider: str,
        *,
        source_name: str = "upload.jsonl",
        context_id: str | None = None,
        title: str | None = None,
        extensions: dict | None = None,
        shared: bool = False,
    ) -> dict:
        if provider not in {"claude", "codex"}:
            raise Problem(400, "invalid_provider", "Provider must be claude or codex.")
        if not raw.strip():
            raise Problem(400, "empty_input", "The JSONL input is empty.")
        if len(raw) > MAX_IMPORT_BYTES:
            raise Problem(413, "input_too_large", "A snapshot may contain at most 32 MiB.")
        source_name = source_name.replace("\\", "/").rsplit("/", 1)[-1]
        if not source_name or len(source_name) > 255 or any(ord(c) < 32 for c in source_name):
            raise Problem(400, "invalid_source_name", "Provide a filename of 1–255 printable characters.")
        if title is not None and (not title.strip() or len(title) > 200):
            raise Problem(400, "invalid_title", "Title must contain 1–200 characters.")
        if extensions is not None:
            try:
                encoded = json.dumps(extensions, ensure_ascii=True, allow_nan=False)
                if not isinstance(extensions, dict) or len(encoded) > 8192:
                    raise ValueError
                if OVERVIEW_EXTENSION in extensions:
                    raise ValueError
            except (TypeError, ValueError, RecursionError):
                raise Problem(400, "invalid_extensions", "Extensions must be a JSON object of at most 8192 characters.") from None
        # Check ownership before spending work on normalization. Repeat inside the write transaction.
        if context_id:
            with self.connection() as db:
                self._owner(db, user, context_id)
        parsed = normalize(raw, provider)
        parsed.extensions = extensions or {}
        header = parsed.model_dump(exclude={"session": {"messages", "turns"}, "diagnostics": True})
        with self.connection(write=True) as db:
            if context_id:
                self._owner(db, user, context_id)
            query = """SELECT r.* FROM revisions r JOIN contexts c ON c.id=r.context_id
                       WHERE c.owner_id=? AND r.provider=? AND r.source_sha256=? AND r.parser_version=?"""
            args = [user, provider, parsed.source_sha256, PARSER_VERSION]
            if context_id:
                query += " AND c.id=?"
                args.append(context_id)
            old = db.execute(query + " ORDER BY r.created_at,r.id LIMIT 1", args).fetchone()
            # A successful idempotent import also guarantees that its original is readable.
            self.archive(raw, parsed.source_sha256)
            if old:
                if extensions is not None and json.loads(old["header_json"]).get("extensions", {}) != extensions:
                    raise Problem(409, "extensions_conflict", "This snapshot already exists with different immutable extensions.")
                if shared:
                    db.execute("INSERT OR IGNORE INTO publications VALUES (?,?)", (old["id"], now()))
                old_title = db.execute("SELECT title FROM contexts WHERE id=?", (old["context_id"],)).fetchone()[0]
                self._save_overview(db, old["id"], parsed, old_title)
                return {**self._revision(db, old), "reused": True}
            created_at = now()
            if context_id is None:
                context_id = str(uuid.uuid4())
                db.execute(
                    "INSERT INTO contexts VALUES (?,?,?,?)",
                    (context_id, user, title or build_overview(parsed)["title"], created_at),
                )
            number = db.execute(
                "SELECT coalesce(max(number),0)+1 FROM revisions WHERE context_id=?", (context_id,)
            ).fetchone()[0]
            rid = str(uuid.uuid4())
            db.execute(
                "INSERT INTO revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    rid,
                    context_id,
                    number,
                    provider,
                    parsed.source_sha256,
                    len(raw),
                    source_name,
                    PARSER_VERSION,
                    parsed.status,
                    created_at,
                    json_text(header),
                    len(parsed.session.messages),
                    len(parsed.session.turns),
                    len(parsed.diagnostics),
                ),
            )
            db.executemany(
                "INSERT INTO turns VALUES (?,?,?,?)",
                [(rid, t.sequence, t.id, json_text(t.model_dump())) for t in parsed.session.turns],
            )
            db.executemany(
                "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)",
                [
                    (
                        rid,
                        m.sequence,
                        m.id,
                        m.turn_id,
                        m.role,
                        m.is_meta,
                        json_text(m.model_dump(exclude={"content"})),
                        json_text([b.model_dump() for b in m.content]),
                    )
                    for m in parsed.session.messages
                ],
            )
            db.executemany(
                "INSERT INTO diagnostics VALUES (?,?,?)",
                [(rid, n, json_text(d.model_dump())) for n, d in enumerate(parsed.diagnostics, 1)],
            )
            row = db.execute("SELECT * FROM revisions WHERE id=?", (rid,)).fetchone()
            if shared:
                db.execute("INSERT INTO publications VALUES (?,?)", (rid, created_at))
            self._save_overview(db, rid, parsed, title)
            return {**self._revision(db, row), "reused": False}

    @staticmethod
    def _owner(db, user, context_id):
        row = db.execute("SELECT * FROM contexts WHERE id=? AND owner_id=?", (context_id, user)).fetchone()
        if row is None:
            raise not_found()
        return row

    @staticmethod
    def _visible(db, user, context_id, revision_id=None, *, raw=False, shared_only=False):
        row = db.execute(
            """SELECT r.*,c.owner_id,g.include_raw,p.revision_id IS NOT NULL AS shared FROM revisions r
            JOIN contexts c ON c.id=r.context_id
            LEFT JOIN grants g ON g.revision_id=r.id AND g.user_id=?
            LEFT JOIN publications p ON p.revision_id=r.id
            WHERE r.context_id=? AND (c.owner_id=? OR g.user_id IS NOT NULL OR p.revision_id IS NOT NULL)
            AND (?=0 OR p.revision_id IS NOT NULL)
            AND (? IS NULL OR r.id=?) ORDER BY r.number DESC LIMIT 1""",
            (user, context_id, user, shared_only, revision_id, revision_id),
        ).fetchone()
        if row is None or (raw and row["owner_id"] != user and not row["include_raw"]):
            raise not_found()
        return row

    @staticmethod
    def _save_overview(db, revision_id, parsed, title):
        db.execute("INSERT OR IGNORE INTO revision_overviews VALUES (?,?)",
                   (revision_id, json_text(build_overview(parsed, title))))

    @staticmethod
    def _header(db, row):
        value = json.loads(row["header_json"])
        overview = db.execute("SELECT data_json FROM revision_overviews WHERE revision_id=?", (row["id"],)).fetchone()
        if overview:
            value.setdefault("extensions", {})[OVERVIEW_EXTENSION] = json.loads(overview[0])
        return value

    def _revision(self, db, row):
        fields = (
            "id",
            "context_id",
            "number",
            "provider",
            "source_sha256",
            "source_bytes",
            "source_name",
            "parser_version",
            "status",
            "created_at",
            "message_count",
            "turn_count",
            "diagnostic_count",
        )
        return {**{k: row[k] for k in fields}, "normalized": self._header(db, row)}

    def list_contexts(self, user, *, limit=20, cursor=None, shared_only=False):
        scope = f"contexts:{user}:shared" if shared_only else f"contexts:{user}"
        position = decode_cursor(cursor, scope, 2**63 - 1)
        published = """EXISTS (SELECT 1 FROM revisions r JOIN publications p ON p.revision_id=r.id
                       WHERE r.context_id=c.id)"""
        visibility = published if shared_only else f"""(c.owner_id=? OR {published} OR EXISTS
            (SELECT 1 FROM revisions r JOIN grants g ON g.revision_id=r.id
             WHERE r.context_id=c.id AND g.user_id=?))"""
        args = (position, limit + 1) if shared_only else (position, user, user, limit + 1)
        with self.connection() as db:
            rows = db.execute(
                f"""SELECT c.rowid AS position,c.* FROM contexts c WHERE c.rowid<? AND
                {visibility} ORDER BY c.rowid DESC LIMIT ?""", args,
            ).fetchall()
            items = [
                {
                    "id": c["id"],
                    "title": c["title"],
                    "owner_id": c["owner_id"],
                    "created_at": c["created_at"],
                    "revision": self._revision(db, self._visible(db, user, c["id"], shared_only=shared_only)),
                }
                for c in rows[:limit]
            ]
        return {
            "items": items,
            "next_cursor": encode_cursor(scope, rows[limit - 1]["position"]) if len(rows) > limit else None,
        }

    def get_context(self, user, context_id, revision_id=None):
        with self.connection() as db:
            revision = self._visible(db, user, context_id, revision_id)
            ctx = db.execute("SELECT * FROM contexts WHERE id=?", (context_id,)).fetchone()
            return {
                **dict(ctx),
                "revision": self._revision(db, revision),
                "access": {
                    "owner": ctx["owner_id"] == user,
                    "raw": ctx["owner_id"] == user or bool(revision["include_raw"]),
                    "shared": bool(revision["shared"]),
                },
            }

    def list_revisions(self, user, context_id, *, limit=20, cursor=None):
        scope = f"revisions:{context_id}"
        position = decode_cursor(cursor, scope, 2**63 - 1)
        with self.connection() as db:
            self._visible(db, user, context_id)
            rows = db.execute(
                """SELECT r.* FROM revisions r JOIN contexts c ON c.id=r.context_id
                LEFT JOIN grants g ON g.revision_id=r.id AND g.user_id=?
                LEFT JOIN publications p ON p.revision_id=r.id
                WHERE r.context_id=? AND r.number<?
                AND (c.owner_id=? OR g.user_id IS NOT NULL OR p.revision_id IS NOT NULL)
                ORDER BY r.number DESC LIMIT ?""",
                (user, context_id, position, user, limit + 1),
            ).fetchall()
            items = [self._revision(db, r) for r in rows[:limit]]
        return {
            "items": items,
            "next_cursor": encode_cursor(scope, rows[limit - 1]["number"]) if len(rows) > limit else None,
        }

    def read_page(
        self,
        user,
        context_id,
        revision_id,
        resource,
        *,
        limit=20,
        cursor=None,
        view="trace",
        turn_id=None,
        tail_turns=None,
    ):
        if resource not in {"messages", "turns", "diagnostics"}:
            raise not_found()
        scope = digest(json_text([context_id, revision_id, resource, view, turn_id, tail_turns]).encode())
        position = decode_cursor(cursor, scope)
        where = "revision_id=? AND sequence>?"
        args = [revision_id, position]
        with self.connection() as db:
            self._visible(db, user, context_id, revision_id)
            if resource == "messages":
                if view == "conversation":
                    where += " AND role IN ('user','assistant') AND is_meta=0"
                if turn_id:
                    if not db.execute(
                        "SELECT 1 FROM turns WHERE revision_id=? AND id=?", (revision_id, turn_id)
                    ).fetchone():
                        raise not_found()
                    where += " AND turn_id=?"
                    args.append(turn_id)
                if tail_turns:
                    where += " AND turn_id IN (SELECT id FROM turns WHERE revision_id=? ORDER BY sequence DESC LIMIT ?)"
                    args += [revision_id, tail_turns]
            # Table names come only from the fixed allowlist above.
            rows = db.execute(
                f"SELECT * FROM {resource} WHERE {where} ORDER BY sequence LIMIT ?", (*args, limit + 1)
            ).fetchall()
            items = []
            for row in rows[:limit]:
                item = json.loads(row["data_json"])
                if resource == "messages":
                    content = row["content_json"]
                    truncated = len(content) > MAX_INLINE_CHARS
                    item.update(
                        content=None if truncated else json.loads(content),
                        content_truncated=truncated,
                        content_chars=len(content),
                    )
                    if truncated:
                        item.update(
                            content_preview=content[:512],
                            content_url=f"/v1/contexts/{context_id}/revisions/{revision_id}/messages/{row['id']}/content",
                        )
                items.append(item)
        return {
            "revision_id": revision_id,
            "items": items,
            "next_cursor": encode_cursor(scope, rows[limit - 1]["sequence"]) if len(rows) > limit else None,
        }

    def content_chunk(self, user, context_id, revision_id, message_id, *, offset=0, limit=MAX_CHUNK_CHARS):
        with self.connection() as db:
            self._visible(db, user, context_id, revision_id)
            row = db.execute(
                "SELECT content_json FROM messages WHERE revision_id=? AND id=?", (revision_id, message_id)
            ).fetchone()
            if row is None:
                raise not_found()
            value = row[0]
            if offset > len(value):
                raise Problem(400, "invalid_offset", "Offset exceeds content length.")
            end = min(offset + limit, len(value))
            return {
                "revision_id": revision_id,
                "message_id": message_id,
                "encoding": "json-text",
                "offset_unit": "unicode_codepoint",
                "offset": offset,
                "total_chars": len(value),
                "text": value[offset:end],
                "next_offset": end if end < len(value) else None,
            }

    def read_raw(self, user, context_id, revision_id):
        with self.connection() as db:
            row = self._visible(db, user, context_id, revision_id, raw=True)
            return self.verified_raw(row["source_sha256"]), row["source_sha256"]

    def set_publication(self, user, context_id, revision_id, *, shared=True):
        """Publish a fixed normalized snapshot to all authenticated users of this instance."""
        with self.connection(write=True) as db:
            self._owner(db, user, context_id)
            self._visible(db, user, context_id, revision_id)
            if shared:
                db.execute("INSERT OR IGNORE INTO publications VALUES (?,?)", (revision_id, now()))
            else:
                db.execute("DELETE FROM publications WHERE revision_id=?", (revision_id,))
        return {"revision_id": revision_id, "shared": shared}

    def set_grant(self, user, context_id, revision_id, recipient, include_raw=False):
        with self.connection(write=True) as db:
            self._owner(db, user, context_id)
            self._visible(db, user, context_id, revision_id)
            if recipient == user:
                raise Problem(400, "owner_grant", "The owner already has access.")
            if not db.execute("SELECT 1 FROM users WHERE id=?", (recipient,)).fetchone():
                raise Problem(400, "unknown_recipient", "Create the recipient locally before sharing.")
            db.execute(
                """INSERT INTO grants VALUES (?,?,?,?) ON CONFLICT(revision_id,user_id)
                DO UPDATE SET include_raw=excluded.include_raw""",
                (revision_id, recipient, include_raw, now()),
            )
        return {"revision_id": revision_id, "user_id": recipient, "include_raw": include_raw}

    def grants(self, user, context_id, revision_id):
        with self.connection() as db:
            self._owner(db, user, context_id)
            self._visible(db, user, context_id, revision_id)
            rows = db.execute(
                "SELECT * FROM grants WHERE revision_id=? ORDER BY user_id", (revision_id,)
            ).fetchall()
            return {"items": [dict(r) for r in rows]}

    def revoke(self, user, context_id, revision_id, recipient):
        with self.connection(write=True) as db:
            self._owner(db, user, context_id)
            self._visible(db, user, context_id, revision_id)
            db.execute("DELETE FROM grants WHERE revision_id=? AND user_id=?", (revision_id, recipient))

    def export(self, user, context_id, revision_id) -> dict:
        # CLI assembles pages; this internal method is also used for integrity checks.
        with self.connection() as db:
            row = self._visible(db, user, context_id, revision_id)
            value = self._header(db, row)
            value["session"]["turns"] = [
                json.loads(r[0])
                for r in db.execute(
                    "SELECT data_json FROM turns WHERE revision_id=? ORDER BY sequence", (revision_id,)
                )
            ]
            value["session"]["messages"] = [
                {**json.loads(r[0]), "content": json.loads(r[1])}
                for r in db.execute(
                    "SELECT data_json,content_json FROM messages WHERE revision_id=? ORDER BY sequence",
                    (revision_id,),
                )
            ]
            value["diagnostics"] = [
                json.loads(r[0])
                for r in db.execute(
                    "SELECT data_json FROM diagnostics WHERE revision_id=? ORDER BY sequence", (revision_id,)
                )
            ]
            return NormalizedContext.model_validate(value).model_dump()

    def check(self) -> dict:
        with self.connection() as db:
            integrity = [r[0] for r in db.execute("PRAGMA integrity_check")]
            foreign_keys = [list(r) for r in db.execute("PRAGMA foreign_key_check")]
            refs = db.execute("SELECT DISTINCT source_sha256 FROM revisions").fetchall()
            revisions = db.execute(
                "SELECT r.*,c.owner_id FROM revisions r JOIN contexts c ON c.id=r.context_id"
            ).fetchall()
        errors = []
        for ref in refs:
            try:
                self.verified_raw(ref[0])
            except Problem as exc:
                errors.append({"sha256": ref[0], "code": exc.code})
        for rev in revisions:
            try:
                value = self.export(rev["owner_id"], rev["context_id"], rev["id"])
                if (
                    value["source_sha256"] != rev["source_sha256"]
                    or value["source_bytes"] != rev["source_bytes"]
                    or value["provider"] != rev["provider"]
                    or value["parser_version"] != rev["parser_version"]
                    or len(value["session"]["messages"]) != rev["message_count"]
                    or len(value["session"]["turns"]) != rev["turn_count"]
                    or len(value["diagnostics"]) != rev["diagnostic_count"]
                ):
                    raise ValueError("Catalog and normalized snapshot disagree")
            except (Problem, ValueError):
                errors.append({"revision_id": rev["id"], "code": "normalized_invalid"})
        return {
            "ok": integrity == ["ok"] and not foreign_keys and not errors,
            "sqlite": integrity,
            "foreign_keys": foreign_keys,
            "archive_count": len(refs),
            "revision_count": len(revisions),
            "errors": errors,
        }

    def backup(self, destination: str | Path) -> dict:
        dest = Path(destination).expanduser().resolve()
        dest.mkdir(parents=True, exist_ok=False, mode=0o700)
        # Immutable originals are retained, so copying referenced files after this snapshot is safe.
        with (
            closing(sqlite3.connect(self.db_path)) as source,
            closing(sqlite3.connect(dest / "junction.sqlite3")) as target,
        ):
            source.backup(target)
            refs = target.execute("SELECT DISTINCT source_sha256 FROM revisions").fetchall()
        (dest / "junction.sqlite3").chmod(0o600)
        for (sha,) in refs:
            data = self.verified_raw(sha)
            path = dest / "raw" / sha[:2] / (sha + ".jsonl")
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with path.open("xb") as stream:
                os.chmod(path, 0o600)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            sync_directory(path.parent)
        check = Store(dest).check()
        if not check["ok"]:
            raise Problem(500, "backup_invalid", "Backup validation failed; destination is incomplete.")
        marker = dest / "BACKUP_COMPLETE.json"
        marker.write_text(json_text({"created_at": now(), "database_version": DB_VERSION, **check}) + "\n")
        with marker.open("rb") as stream:
            os.fsync(stream.fileno())
        sync_directory(dest)
        return {"path": str(dest), **check}
