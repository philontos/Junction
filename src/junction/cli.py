"""Thin JSON client and local administration commands."""

import argparse
import hashlib
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .errors import Problem
from .models import NormalizedContext
from .store import MAX_IMPORT_BYTES, Store, new_token, sync_directory


def print_json(value, *, stream=sys.stdout):
    print(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), file=stream)


def save_new(path: str | Path, data: bytes):
    """Publish complete private files without replacing an existing destination."""
    path = Path(path).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix=".junction-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temp, path)
        sync_directory(path.parent)
    finally:
        os.unlink(temp)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a bearer token to a redirect target.
        return None


class Client:
    def __init__(self, url, token_file):
        parsed = urllib.parse.urlsplit(url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.username
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Provide an http(s) service URL without credentials, query or fragment.")
        self.url = url.rstrip("/")
        self.token = Path(token_file).expanduser().read_text().strip()
        if not self.token or any(c.isspace() for c in self.token):
            raise ValueError("Token file is empty or malformed.")
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, path, *, method="GET", params=None, body=None, raw=False):
        query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})
        url = self.url + path + ("?" + query if query else "")
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json"}
        if isinstance(body, bytes):
            headers["Content-Type"] = "application/x-ndjson"
        elif body is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(body).encode()
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=120) as response:
                data = response.read()
                return data if raw else json.loads(data) if data else None
        except urllib.error.HTTPError as exc:
            try:
                error = json.loads(exc.read()).get("error", {})
            except (ValueError, UnicodeError):
                error = {}
            raise Problem(
                exc.code,
                error.get("code", "http_error"),
                error.get("detail", f"Service returned HTTP {exc.code}."),
            ) from None

    def resolve(self, context_id, revision_id=None):
        path = "/v1/contexts/" + urllib.parse.quote(context_id, safe="")
        if revision_id:
            path += "/revisions/" + urllib.parse.quote(revision_id, safe="")
        meta = self.request(path)
        base = "/v1/contexts/" + meta["id"] + "/revisions/" + meta["revision"]["id"]
        return meta, base

    def all_items(self, path):
        cursor = None
        while True:
            page = self.request(path, params={"cursor": cursor})
            yield from page["items"]
            cursor = page["next_cursor"]
            if cursor is None:
                break

    def export(self, meta, base):
        value = meta["revision"]["normalized"]
        value["session"]["turns"] = list(self.all_items(base + "/turns"))
        messages = []
        for message in self.all_items(base + "/messages"):
            if message.pop("content_truncated"):
                offset, parts = 0, []
                while offset is not None:
                    chunk = self.request(
                        base + "/messages/" + message["id"] + "/content", params={"offset": offset}
                    )
                    parts.append(chunk["text"])
                    offset = chunk["next_offset"]
                message["content"] = json.loads("".join(parts))
            for key in ("content_preview", "content_url", "content_chars"):
                message.pop(key, None)
            messages.append(message)
        value["session"]["messages"] = messages
        value["diagnostics"] = list(self.all_items(base + "/diagnostics"))
        return NormalizedContext.model_validate(value).model_dump()


def parser():
    root = argparse.ArgumentParser(prog="junction", description="Store and share agent context snapshots.")
    root.add_argument("--url", default=os.environ.get("JUNCTION_URL", "http://127.0.0.1:8767"))
    root.add_argument("--token-file", default=os.environ.get("JUNCTION_TOKEN_FILE", ".local/local.token"))
    sub = root.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="Run the HTTP service (loopback by default)")
    serve.add_argument("--data-dir", default=".local/data")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", default=8767, type=int)
    serve.add_argument("--hosts", help="Comma-separated bind addresses; overrides --host")
    admin = sub.add_parser("user-add", help="Create a user or rotate their token locally")
    admin.add_argument("user")
    admin.add_argument("--data-dir", default=".local/data")
    admin.add_argument("--output-token", required=True, help="New private file; never overwritten")
    admin.add_argument("--rotate", action="store_true")
    check = sub.add_parser("check", help="Check database, normalized records and raw checksums")
    check.add_argument("--data-dir", default=".local/data")
    backup = sub.add_parser("backup", help="Create and verify a consistent backup in a new directory")
    backup.add_argument("destination")
    backup.add_argument("--data-dir", default=".local/data")
    sub.add_parser("whoami")
    imp = sub.add_parser("import", help="Import an existing JSONL file as an immutable snapshot")
    imp.add_argument("file")
    imp.add_argument("--provider", choices=["claude", "codex"], required=True)
    imp.add_argument("--context", help="Append to an owned context; otherwise create or deduplicate")
    imp.add_argument("--title")
    imp.add_argument("--extensions-file", help="JSON object with immutable namespaced metadata (max 8192 characters)")
    imp.add_argument("--shared", action="store_true", help="Share this snapshot with all Junction users")
    listing = sub.add_parser("list")
    listing.add_argument("--cursor")
    listing.add_argument("--limit", type=int, default=20)
    listing.add_argument("--shared", action="store_true", help="List only shared snapshots")
    for name in ("get", "revisions", "export", "raw", "publish", "unpublish", "share", "revoke", "grants", "content"):
        cmd = sub.add_parser(name)
        cmd.add_argument("context")
        cmd.add_argument("--revision", required=name in {"publish", "unpublish", "share", "revoke", "grants", "content"})
        if name == "get":
            cmd.add_argument(
                "--view",
                choices=["session", "turns", "conversation", "trace", "diagnostics"],
                default="session",
            )
            cmd.add_argument("--turns", type=int, help="Read the last N recorded turns")
            cmd.add_argument("--turn-id")
        if name in {"get", "revisions"}:
            cmd.add_argument("--cursor")
            cmd.add_argument("--limit", type=int, default=20)
        if name in {"raw", "export"}:
            cmd.add_argument("--output", required=True)
        if name in {"share", "revoke"}:
            cmd.add_argument("--user", required=True)
        if name == "share":
            cmd.add_argument("--include-raw", action="store_true")
        if name == "content":
            cmd.add_argument("--message", required=True)
            cmd.add_argument("--offset", type=int, default=0)
            cmd.add_argument("--limit", type=int, default=16384)
    return root


def run(args):
    if args.command == "serve":
        import uvicorn

        from .api import create_app

        config = uvicorn.Config(
            create_app(args.data_dir),
            host=args.host, port=args.port, workers=1, access_log=False,
            timeout_keep_alive=5, limit_concurrency=32,
        )
        if not args.hosts:
            uvicorn.Server(config).run()
        else:
            import socket

            sockets = []
            try:
                for host in dict.fromkeys(h.strip() for h in args.hosts.split(",") if h.strip()):
                    family, kind, proto, _, address = socket.getaddrinfo(host, args.port, type=socket.SOCK_STREAM)[0]
                    sock = socket.socket(family, kind, proto)
                    sockets.append(sock)
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    sock.bind(address)
                    sock.listen(128)
                if not sockets:
                    raise ValueError("--hosts requires at least one bind address")
                uvicorn.Server(config).run(sockets=sockets)
            finally:
                for sock in sockets:
                    sock.close()
        return
    if args.command == "user-add":
        token = new_token()
        store = Store(args.data_dir)
        save_new(args.output_token, (token + "\n").encode())
        try:
            store.add_user(args.user, token, rotate=args.rotate)
        except BaseException:
            # This file was created exclusively by this operation, never an existing credential.
            Path(args.output_token).expanduser().unlink()
            raise
        print_json(
            {
                "user_id": args.user,
                "token_file": str(Path(args.output_token).expanduser().resolve()),
                "rotated": args.rotate,
            }
        )
        return
    if args.command == "check":
        result = Store(args.data_dir).check()
        print_json(result)
        if not result["ok"]:
            raise SystemExit(1)
        return
    if args.command == "backup":
        print_json(Store(args.data_dir).backup(args.destination))
        return
    client = Client(args.url, args.token_file)
    if args.command == "whoami":
        print_json(client.request("/v1/me"))
        return
    if args.command == "import":
        path = Path(args.file).expanduser()
        with path.open("rb") as stream:
            raw = stream.read(MAX_IMPORT_BYTES + 1)
        if len(raw) > MAX_IMPORT_BYTES:
            raise ValueError("A snapshot may contain at most 32 MiB.")
        print_json(
            client.request(
                "/v1/imports",
                method="POST",
                body=raw,
                params={
                    "provider": args.provider,
                    "source_name": path.name,
                    "context_id": args.context,
                    "title": args.title,
                    "extensions": Path(args.extensions_file).read_text() if args.extensions_file else None,
                    "shared": args.shared,
                },
            )
        )
        return
    if args.command == "list":
        print_json(client.request("/v1/contexts", params={
            "limit": args.limit, "cursor": args.cursor, "shared_only": args.shared,
        }))
        return
    meta, base = client.resolve(args.context, args.revision)
    if args.command == "get":
        if args.view == "session":
            print_json(meta)
        else:
            resource = "messages" if args.view in {"conversation", "trace"} else args.view
            print_json(
                client.request(
                    base + "/" + resource,
                    params={
                        "view": args.view if resource == "messages" else None,
                        "tail_turns": args.turns,
                        "turn_id": args.turn_id,
                        "limit": args.limit,
                        "cursor": args.cursor,
                    },
                )
            )
    elif args.command == "revisions":
        print_json(
            client.request(
                "/v1/contexts/" + meta["id"] + "/revisions",
                params={"limit": args.limit, "cursor": args.cursor},
            )
        )
    elif args.command in {"publish", "unpublish"}:
        result = client.request(base + "/publication", method="PUT" if args.command == "publish" else "DELETE")
        print_json(result or {"revision_id": meta["revision"]["id"], "shared": False})
    elif args.command in {"share", "revoke"}:
        path = base + "/grants/" + urllib.parse.quote(args.user, safe="")
        result = client.request(
            path,
            method="PUT" if args.command == "share" else "DELETE",
            body={"include_raw": args.include_raw} if args.command == "share" else None,
        )
        print_json(result or {"revoked": True, "revision_id": meta["revision"]["id"], "user_id": args.user})
    elif args.command == "grants":
        print_json(client.request(base + "/grants"))
    elif args.command == "content":
        print_json(
            client.request(
                base + "/messages/" + urllib.parse.quote(args.message, safe="") + "/content",
                params={"offset": args.offset, "limit": args.limit},
            )
        )
    elif args.command in {"raw", "export"}:
        if args.command == "raw":
            data = client.request(base + "/raw", raw=True)
            if hashlib.sha256(data).hexdigest() != meta["revision"]["source_sha256"]:
                raise ValueError("Downloaded original checksum does not match the revision.")
        else:
            data = (json.dumps(client.export(meta, base), ensure_ascii=False, indent=2) + "\n").encode()
        save_new(args.output, data)
        print_json(
            {
                "context_id": meta["id"],
                "revision_id": meta["revision"]["id"],
                "output": str(Path(args.output).expanduser().resolve()),
                "bytes": len(data),
            }
        )


def main():
    try:
        run(parser().parse_args())
    except Problem as exc:
        print_json(
            {"error": {"code": exc.code, "detail": exc.detail, "status": exc.status}}, stream=sys.stderr
        )
        raise SystemExit(1) from None
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print_json({"error": {"code": "client_error", "detail": str(exc)}}, stream=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
