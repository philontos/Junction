"""Exercise two pinned official pure functions with synthetic entries only.

Usage: python3.12 probe-claude-fork.py SESSION_MUTATIONS_PY OUTPUT_JSON
No SDK installation, real transcripts, CLI startup, or model calls.
"""

import ast
import copy
import hashlib
import json
import platform
import sys
import uuid as uuid_mod
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

COMMIT = "2146f9d8985513053e904b13200c8f744b36785a"
EXPECTED_SHA256 = "16653fb5dbb6e9963e05ef1522e43ba4b8e28fd0b037e4749dde865ca9e4e675"
source_path, output_path = map(Path, sys.argv[1:])
source = source_path.read_bytes()
assert hashlib.sha256(source).hexdigest() == EXPECTED_SHA256, "Source differs from pinned review"
assert not output_path.exists(), "Refusing to replace an existing result"

# Execute original AST nodes, not a rewritten implementation. Only these pure
# transforms and their constant are loaded; filesystem/store entry points are not.
tree = ast.parse(source, filename=str(source_path))
names = {"_parse_fork_transcript", "_build_fork_lines"}
nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
nodes += [n for n in tree.body if isinstance(n, ast.Assign)
          and any(isinstance(t, ast.Name) and t.id == "_TRANSCRIPT_TYPES" for t in n.targets)]
assert len(nodes) == 3
scope = dict(json=json, uuid_mod=uuid_mod, datetime=datetime, timezone=timezone,
             Any=Any, Callable=Callable)
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source_path), "exec"), scope)

session_id = "00000000-0000-4000-8000-000000000001"
def entry(kind, ident, parent, **extra):
    return dict(type=kind, uuid=ident, parentUuid=parent, sessionId=session_id,
                timestamp="2026-01-01T00:00:00Z", **extra)

raw = [
    entry("user", "u1", None, message={"role": "user", "content": "Synthetic task"}),
    entry("assistant", "a1", "u1", futureField={"retained": True}, message={
        "role": "assistant", "content": [{"type": "tool_use", "id": "call-original", "name": "Read", "input": {"path": "fixture"}}]}),
    entry("progress", "p1", "a1"),
    entry("user", "r1", "p1", message={"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call-original", "content": "Synthetic result"}]}),
    entry("system", "c1", None, subtype="compact_boundary", logicalParentUuid="r1"),
    entry("user", "s1", "c1", isMeta=True, message={"role": "user", "content": "Synthetic summary"}),
    entry("assistant", "side", "s1", isSidechain=True),
    entry("file-history-snapshot", "snapshot", None),
]
original = copy.deepcopy(raw)
transcript, replacements = scope["_parse_fork_transcript"](
    "\n".join(map(json.dumps, raw)).encode(), session_id)
fork_id, lines = scope["_build_fork_lines"](
    transcript, replacements, session_id, None, "Synthetic fork", lambda: None)
forked = [json.loads(line) for line in lines]
messages = [e for e in forked if "forkedFrom" in e]
by_source = {e["forkedFrom"]["messageUuid"]: e for e in messages}

assert fork_id != session_id
assert all(e["sessionId"] == fork_id and e["uuid"] != old for old, e in by_source.items())
assert by_source["r1"]["parentUuid"] == by_source["a1"]["uuid"]
assert by_source["c1"]["logicalParentUuid"] == by_source["r1"]["uuid"]
assert by_source["a1"]["futureField"] == {"retained": True}
assert by_source["a1"]["message"]["content"][0]["id"] == "call-original"
assert by_source["r1"]["message"]["content"][0]["tool_use_id"] == "call-original"
assert set(by_source) == {"u1", "a1", "r1", "c1", "s1"}
assert raw == original

_, cutoff_lines = scope["_build_fork_lines"](
    transcript, replacements, session_id, "a1", "Cutoff", lambda: None)
cutoff = [json.loads(line) for line in cutoff_lines]
assert [e["forkedFrom"]["messageUuid"] for e in cutoff if "forkedFrom" in e] == ["u1", "a1"]

result = {
    "source_commit": COMMIT,
    "source_sha256": EXPECTED_SHA256,
    "python": platform.python_version(),
    "scope": "Original pure AST functions; synthetic entries; not CLI resume or fork integration",
    "cases": [
        {"name": "fork_identity_and_edges", "passed": True,
         "observed": "Session/message UUIDs remapped; progress parent bypassed; compaction logical parent remapped; tool-call IDs and unknown field retained"},
        {"name": "fork_scope_and_source", "passed": True,
         "observed": "Sidechain/progress/file-history snapshot omitted; isMeta retained; input unchanged", "retained_messages": len(messages)},
        {"name": "inclusive_cutoff", "passed": True,
         "retained_source_ids": ["u1", "a1"]},
    ],
}
with output_path.open("x") as out:
    json.dump(result, out, indent=2, ensure_ascii=False)
    out.write("\n")
print(json.dumps({"cases": len(result["cases"]), "passed": True}))
