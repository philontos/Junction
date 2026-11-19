# Agent adapters

One toolkit, two runtimes:

- `node/`: launch arguments, exact native session lookup, reading-view records and image paste behavior. Workbench supplies a minimal task and command runner; adapters do not import its database.
- `python/`: portable context models, byte-level provenance and versioned JSONL normalization. Junction stores raw bytes separately from the normalized projection.

Node reading views may truncate tool output for display; Python normalization preserves available archive information. These are intentionally distinct contracts, not two competing definitions of persisted Context.

To add an Agent, register its Node adapter in `node/index.ts` and its native format in `python/src/junction_adapters/parsers/registry.py`. An executable may be supported before sharing is implemented: advertise `nativeFormat: null` until a parser exists. Keep unknown records and diagnostics, add sanitized fixtures, and verify exact session binding and duplicate/branch handling. Do not install or execute adapter code obtained from shared Context.

See the [normalization contract](../../services/junction/docs/adapter-contract.md). The portable schema remains `junction.context/1`; this extraction does not change archived data.
