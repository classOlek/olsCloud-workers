# Snapshot state rework — phased implementation plan

Status: **planned** (no code changed yet). Branch: `claude/snapshot-collection-rework-3izqbz`.

## Goal

Replace the chunk-file work-distribution model with a single-file snapshot state:

- A snapshot is **one private NDJSON.gz state file** — one line per character with
  identity, `outcome`/`attempts`, and (once collected) `characterData` + `passiveTree`.
- **Coordinate** filters still-uncollected characters **in memory** (streamed) and
  fans workers out with only `workerIndex`/`workerCount` — no chunk files on R2.
- **Workers** deterministically self-select their share of the pending characters,
  fetch from GGG, and hand results to **finalize**, which merges them into the
  snapshot state file and publishes as today.

Net effect: hundreds of chunk + raw-shard objects per snapshot collapse to one
durable state file (plus ≤ workerCount transient result files per fire), far fewer
R2 class-A/B operations, and one authoritative place where a snapshot's data lives.

## Design decisions (locked before Phase 1)

These answer the gaps a naive "one file + parameters + return values" version has:

1. **Keep the small manifest** (`state/<league>/current.json`). Coordinate's
   no-op check must stay request-free and byte-free — an idle 10-minute tick must
   not download a multi-hundred-MB state file. The manifest keeps the outcome
   tally (`has_work`) and the worker matrix inputs.
2. **Never pass character lists through workflow outputs.** GitHub Actions step
   outputs cap at ~1 MB; a grown roster's pending list would hit that cliff
   mid-league. Workers receive only `workerIndex`/`workerCount` (exactly today's
   contract) and re-derive the identical split by streaming the state file and
   applying the same deterministic filter the coordinator used.
3. **Worker results go to R2, not GitHub artifacts.** A fire's artifacts are
   invisible to the next fire, so a failed finalize would throw away a whole wave
   of GGG requests (against hard rule #1), and artifacts count against Actions
   storage on private repos. Instead each worker owns exactly one result object
   per snapshot (`w<N>.ndjson.gz`), overwritten in place — single writer by
   construction, durable across a failed finalize, swept by the next one.
4. **Workers checkpoint their result file periodically** (every K resolved
   characters / few minutes), not only at end-of-run. Loss granularity on a
   worker crash stays "a few characters", not "a 40-minute run of GGG fetches".
5. **The state file is streamed, never `JSON.parse`d whole.** 15k+ characters ×
   15–50 KB of raw JSON is 250–750 MB — over V8's ~512 MB string cap as a single
   document. NDJSON (one character per line, gzipped) keeps every reader/writer
   a line-at-a-time stream; workers retain only owned pending identities.
6. **The state file is the raw.** Transform already consumes gzipped NDJSON
   shards; it switches to consuming `outcome == 'ok'` lines of the state file.
   On final (immutable) publish the state file is deleted exactly as raw shards
   are today; the published `snapshots/…` layout (meta / agg / parquet / index)
   does not change at all.
7. **Schema bump to v4.** Chunk types disappear from `shared/`; the manifest
   loses `chunkSize`/`chunkCount`/`resolvedChunks`. Update the web-reader copy of
   `shared/` in lockstep (published formats are unchanged, but the contract file
   is shared). Migration: a create fire that finds a foreign-schema in-flight
   snapshot discards it and seeds fresh (extends the existing `ladder_capture`
   remnant rule); a legacy-key sweep runs under retention.

### New R2 layout (private, under `state/`)

```
state/<league>/current.json                          # manifest (kept, slimmed)
state/<league>/snapshots/<snapshotId>.ndjson.gz      # THE snapshot state file
state/<league>/results/<snapshotId>/w<NN>.ndjson.gz  # transient per-worker results
```

One line of the state file / a result file:

```jsonc
{ "rank": 12, "account": "a", "character": "c", "class": "Witch", "level": 98,
  "outcome": "ok", "attempts": 1, "fetchedAt": "…",
  "characterData": { /* raw items payload */ }, "passiveTree": { /* raw passives */ } }
```

### Per-fire object traffic (15k characters, 15 workers)

| step        | today (chunks)                          | after rework                         |
|-------------|-----------------------------------------|--------------------------------------|
| coordinate  | 1 manifest read                         | 1 manifest read (unchanged)          |
| worker ×15  | ~20 chunk reads + ~40 writes each       | 1 state-file streamed read + periodic overwrites of 1 result object |
| finalize    | ~300 chunk reads + shard list + manifest| list+read ≤15 results, 1 state-file read + 1 write, manifest |

Bytes moved per active fire go up (whole file × N+2); R2 bills operations, not
bytes, and egress is free — this is the intended trade.

## Phases

Each phase lands green (`pnpm typecheck && pnpm lint && pnpm test`) and is
independently reviewable. Phases 1–2 are pure additions; the pipeline switches
over in 3–5; 6–7 delete the old model and handle rollout.

### Phase 1 — contracts & paths (`shared/`)

- `contracts.ts`: `SCHEMA_VERSION = 4`. New `SnapshotCharacter` = queued identity
  fields + `characterData?` + `passiveTree?`. Slim `SnapshotManifest` (drop
  `chunkSize`, `chunkCount`, `resolvedChunks`; keep `totalCharacters`,
  `outcomes`, phases, transform bookkeeping). Keep `QueuedCharacter`
  tally helpers (they operate on outcome fields and carry over).
- `r2-paths.ts`: add `snapshotStatePath`, `workerResultPath` / `workerResultPrefix`;
  `classifyKey` gains `snapshot-state` and `worker-result`; **keep** the legacy
  `chunk` / raw-shard parsers for the Phase 6 sweep.
- Tests: path round-trips, classifyKey table, tally helpers over the new type.
- Coordinate the `shared/` copy in the web reader (contract change, published
  snapshot formats untouched).

### Phase 2 — snapshot state store (new `collector/src/snapshot-state/`)

The replacement for `chunks/chunk-store.ts`, built around streams:

- `readState(store, league, id)`: async iterator over decoded lines
  (gunzip → line split → JSON per line); corrupt line = hard error.
- `writeState(store, league, id, iterable)`: streamed gzip NDJSON writer.
- `mergeResults(state, results)`: streamed rewrite — read old state, patch
  matched identities from the result records (idempotent: last write per
  identity wins; re-merging the same results is a no-op), write new state.
  Never holds full `characterData` for more than a line at a time.
- `pendingIdentities(state)`: identities + line ordinals of
  `pending`/`retryable` lines (small — no payloads).
- `assignedTo(pendingOrdinals, workerIndex, workerCount)`: the deterministic
  split — ordinal `% workerCount === workerIndex`. Stable and disjoint for a
  given state file version, mirroring today's `ownedChunkIndices` reasoning.
- Unit tests: streaming round-trip at size, merge idempotence, split
  disjointness/stability, corrupt-line failure.

### Phase 3 — seed & close (`run/create-snapshot.ts`, `run/close-snapshot.ts`, `run/discard.ts`)

- Create: seed the state file from the roster in one streamed write (every
  character `pending`, roster order preserved), then write the v4 manifest.
  Order: state file first, manifest second — a crash in between is today's
  `ladder_capture` remnant and is discarded on the next create fire.
- A create fire that finds a **foreign-schema** manifest discards that snapshot
  (state file, results, legacy chunks/raw, incomplete published files, index
  entry) and reseeds — this is the v3→v4 migration path.
- Close: streamed rewrite marking remaining `pending`/`retryable` as `skipped`.
- Discard: delete state file + results prefix (+ legacy prefixes).

### Phase 4 — coordinate & worker (`run/coordinator.ts`, `run/worker.ts`)

- Coordinator: `has_work` from the manifest tally exactly as today; the
  `has_work` / `workers` output contract (`run-summary.ts` keys, CI-asserted)
  does not change. No state-file read on the idle path.
- Worker: stream the state file once at start; keep only owned pending
  identities (deterministic split above). Resolve characters via the untouched
  `resolve-character.ts` / rate-limit stack. Buffer results and **overwrite its
  single result object periodically** and on every clean stop (budget,
  rate-limit stall, quorum, drained). Early-stop quorum, limiter persistence,
  per-IP pace state: unchanged.
- A worker still never writes the manifest, the state file, or another slot's
  objects.

### Phase 5 — finalize & transform (`run/finalize.ts`, `transform/`)

- Finalize: list the results prefix → `mergeResults` into the state file →
  recompute tally → write manifest → **only then** delete result files.
  A crash before the delete re-merges idempotently next fire; a crash before
  the manifest write re-merges too (merge is the recovery path, no special
  cases). Abort path discards as in Phase 3.
- Transform: replace the raw-shard download/gunzip stage with "stream state
  file, emit `outcome == 'ok'` lines to the temp NDJSON DuckDB ingests" — the
  SQL, aggregates, validation gate, meta, and index logic are untouched.
  Incremental (`complete: false`) and final publishes keep their semantics;
  final publish deletes the state file (it *is* the raw now) and the results
  prefix.
- Rework `run/e2e.test.ts` + finalize/worker tests on the run-harness for the
  new resume scenarios: worker crash between checkpoints, finalize crash after
  merge / before delete, double-merge idempotence, close-with-skips.

### Phase 6 — retire the chunk model

- Delete `chunks/chunk-store.ts`, `rawChunkShardPath`/shard helpers, chunk
  fields/usages and their tests.
- Retention / `reset-aborted`: classify and sweep **legacy** `state/…/chunks/`
  and `raw/…` shard keys as orphans (one-release cleanup); keep the legacy
  parsers until the sweep has run in production, then remove in a follow-up.
- Add `collector/scripts/diagnostics/sweep-legacy-state.ts` (dry-run by
  default, `--apply`) for on-demand cleanup and verification via the
  ClaudeDiagnostics workflow.

### Phase 7 — docs, workflows, rollout

- Update comments/contracts in `snapshot.yml` + `new-snapshot.yml` (worker
  matrix semantics, no chunk wording), `CLAUDE.md` hard-rule #3 wording
  (single-owner now: "exactly one writer per R2 object" — worker result files
  replace chunk ownership), and this doc → mark as implemented.
- Rollout order: merge → let the in-flight v3 snapshot finish or force a
  create fire (which discards foreign-schema state) → confirm one full
  seed→collect→finalize cycle on the live league → run the legacy sweep.
- No workflow topology change: same coordinate → matrix → finalize jobs, same
  concurrency group, same external scheduler cadence.

## Invariants preserved (hard rules)

- **#1 API politeness**: fetch pipeline, limiter, pacing, quorum untouched;
  periodic result checkpoints bound wasted requests on crashes.
- **#3 resumability**: every step remains a re-entrant continuation off R2
  state; merge idempotence makes finalize crash-safe; single writer per object
  holds (`manifest`/state file: coordinate-create/finalize only, serialized by
  the concurrency group; result file `w<N>`: exactly one worker).
- **#4 immutability**: unchanged — incomplete publishes overwrite in place,
  final publish freezes.
- **#5 free tiers**: fewer R2 ops; more bytes moved but R2 bills ops and egress
  is free; no artifacts storage dependency.

## Risks & mitigations

| risk | mitigation |
|------|------------|
| State file outgrows streaming assumptions (roster keeps growing) | NDJSON line-at-a-time everywhere; nothing ever holds the whole file; payloads dropped unless owned |
| Finalize rewrite races a worker's result write | No race: fires are serialized by the shared concurrency group; within a fire finalize runs after the matrix |
| Merge bug corrupts the only copy of collected data | Merge writes are full-file puts (atomic on R2); results are deleted only after state + manifest are durably written; golden-file merge tests in Phase 2 |
| v3 snapshot in flight at deploy | Create-fire discard of foreign-schema state (Phase 3); worst case one snapshot's partial work is re-collected once |
| Web reader drift on `shared/` | Contract copy updated in the same change window; published formats identical, so readers of v3 snapshots are unaffected |
