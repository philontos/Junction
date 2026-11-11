import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

import pytest

from junction.models import NormalizedContext, context_schema


def cli(cwd, *args, ok=True):
    env = {k: v for k, v in os.environ.items() if k not in {"JUNCTION_URL", "JUNCTION_TOKEN_FILE"}}
    result = subprocess.run(
        [sys.executable, "-m", "junction.cli", *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if ok:
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)
    assert result.returncode != 0
    return json.loads(result.stderr)


@contextmanager
def running_server(cwd, port):
    with (cwd / "server.log").open("ab") as log:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "junction.cli",
                "serve",
                "--data-dir",
                str(cwd / "data"),
                "--port",
                str(port),
            ],
            cwd=cwd,
            stdout=log,
            stderr=log,
        )
        try:
            for _ in range(150):
                if process.poll() is not None:
                    pytest.fail((cwd / "server.log").read_text())
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=0.2) as response:
                        if response.status == 200:
                            break
                except (OSError, urllib.error.URLError):
                    time.sleep(0.05)
            else:
                pytest.fail("Local service did not become ready")
            yield
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def test_two_users_complete_handoff_via_real_http_and_cli(tmp_path, claude_bytes, codex_bytes):
    for user in ("alice", "bob"):
        cli(tmp_path, "user-add", user, "--data-dir", "data", "--output-token", user + ".token")
        assert (tmp_path / (user + ".token")).stat().st_mode & 0o777 == 0o600
    with socket.socket() as socket_handle:
        socket_handle.bind(("127.0.0.1", 0))
        port = socket_handle.getsockname()[1]
    common = ["--url", f"http://127.0.0.1:{port}"]
    alice = [*common, "--token-file", "alice.token"]
    bob = [*common, "--token-file", "bob.token"]
    with running_server(tmp_path, port):
        assert cli(tmp_path, *alice, "whoami")["user_id"] == "alice"
        for provider, data, owner, recipient, recipient_id in (
            ("claude", claude_bytes, alice, bob, "bob"),
            ("codex", codex_bytes, bob, alice, "alice"),
        ):
            filename = provider + ".jsonl"
            (tmp_path / filename).write_bytes(data)
            first = cli(tmp_path, *owner, "import", filename, "--provider", provider)
            assert first["status"] == "ready"
            assert cli(tmp_path, *owner, "import", filename, "--provider", provider)["reused"]
            cid, rid = first["context_id"], first["id"]
            assert cli(tmp_path, *recipient, "get", cid, ok=False)["error"]["status"] == 404
            cli(tmp_path, *owner, "share", cid, "--revision", rid, "--user", recipient_id)
            conversation = cli(
                tmp_path, *recipient, "get", cid, "--revision", rid, "--view", "conversation", "--turns", "3"
            )
            assert any(item["role"] == "user" for item in conversation["items"])
            exported = provider + ".export.json"
            cli(tmp_path, *recipient, "export", cid, "--revision", rid, "--output", exported)
            normalized = NormalizedContext.model_validate_json((tmp_path / exported).read_bytes())
            assert normalized.source_sha256 == hashlib.sha256(data).hexdigest()
            assert (
                cli(tmp_path, *recipient, "raw", cid, "--revision", rid, "--output", "raw.jsonl", ok=False)[
                    "error"
                ]["status"]
                == 404
            )
            cli(tmp_path, *owner, "share", cid, "--revision", rid, "--user", recipient_id, "--include-raw")
            cli(tmp_path, *recipient, "raw", cid, "--revision", rid, "--output", provider + ".raw.jsonl")
            assert (tmp_path / (provider + ".raw.jsonl")).read_bytes() == data
            assert (tmp_path / filename).read_bytes() == data
            cli(tmp_path, *owner, "revoke", cid, "--revision", rid, "--user", recipient_id)
            assert cli(tmp_path, *recipient, "get", cid, ok=False)["error"]["status"] == 404
            shared = cli(tmp_path, *owner, "import", filename, "--provider", provider, "--shared")
            assert shared["id"] == rid and shared["reused"]
            assert cli(tmp_path, *recipient, "list", "--shared")["items"][0]["revision"]["id"] == rid
            assert cli(tmp_path, *recipient, "get", cid)["access"]["shared"]
            cli(tmp_path, *owner, "unpublish", cid, "--revision", rid)
            assert cli(tmp_path, *recipient, "get", cid, ok=False)["error"]["status"] == 404
            cli(tmp_path, *owner, "publish", cid, "--revision", rid)
            assert cli(tmp_path, *recipient, "get", cid)["access"]["shared"]
            cli(tmp_path, *owner, "unpublish", cid, "--revision", rid)
        assert cli(tmp_path, "check", "--data-dir", "data")["ok"]
        assert cli(tmp_path, "backup", "backup", "--data-dir", "data")["ok"]
    with running_server(tmp_path, port):
        assert cli(tmp_path, *alice, "whoami")["user_id"] == "alice"
        assert len(cli(tmp_path, *alice, "list")["items"]) == 1
        assert len(cli(tmp_path, *bob, "list")["items"]) == 1


def test_user_create_never_overwrites_existing_credentials(tmp_path):
    (tmp_path / "existing.token").write_text("keep-this")
    cli(tmp_path, "user-add", "alice", "--data-dir", "data", "--output-token", "existing.token", ok=False)
    assert (tmp_path / "existing.token").read_text() == "keep-this"
    cli(tmp_path, "user-add", "alice", "--data-dir", "data", "--output-token", "new.token")
    cli(tmp_path, "user-add", "alice", "--data-dir", "data", "--output-token", "failed.token", ok=False)
    assert not (tmp_path / "failed.token").exists()


def test_published_schema_matches_current_writer():
    published = Path(__file__).parents[1] / "schemas" / "context-v1.schema.json"
    assert json.loads(published.read_text()) == context_schema()
