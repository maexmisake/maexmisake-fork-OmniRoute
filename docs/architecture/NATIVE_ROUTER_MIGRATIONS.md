---
title: "Native Router Migration Compatibility"
version: 3.8.52
lastUpdated: 2026-10-26
---

# Native router migration compatibility

The distribution ships **214 SQL files**: 209 core migrations through numeric
`212`, plus five files under `src/lib/db/migrations/native-router/`. The bundled
files use the existing namespace convention and are recorded as `nr-213` through
`nr-217`. They load automatically after core migrations, without an environment
change. The `nr` namespace is reserved; optional extra directories remain separate.

## Verified upstream boundary and later correction

The earlier comparison pinned
[`release/v3.8.53` source at `81e48878`](https://github.com/cheaper-inference/OmniRoute/tree/81e48878b90fb309ede580bca8b97c6953a2fc62/src/lib/db/migrations)
and [`main` source at `edab7c3a`](https://github.com/cheaper-inference/OmniRoute/tree/edab7c3a59bf7d6f040d581dbda3a46adbee0d57/src/lib/db/migrations).
Those immutable trees end at numeric `212`; all 209 core SQL blobs match the
chosen v3.8.52 base `ad6f33f66bda34eba98645d3bfdabbde294bc843`.
Calling that result the current upstream branch state was too broad.

A read-only correction on 26 October 2026 verified that commit
[`860ebfad`](https://github.com/cheaper-inference/OmniRoute/commit/860ebfad6e357cbaf0d918c19ae790de0f95ed69),
merged through [PR #13102](https://github.com/cheaper-inference/OmniRoute/pull/13102)
on **25 October at 22:56:30 UTC**, adds
[`213_api_key_preferred_connections.sql`](https://github.com/cheaper-inference/OmniRoute/blob/db6db55ba8bca51a96d347b9f3cc6399725f2c4b/src/lib/db/migrations/213_api_key_preferred_connections.sql).
Its inclusion is verified at later commit
`db6db55ba8bca51a96d347b9f3cc6399725f2c4b`: 210 core SQL files through `213`,
with all prior 209 blobs unchanged. The addition was merged on October 25,
not October 26. No exact earlier branch-observation time is inferred.

The native namespace therefore avoids a confirmed numeric-version overlap with
upstream `213` as well as future collisions. This is evidence of distinct SQL
identities sharing a number, not a newly reproduced Git merge conflict or a live
upgrade test. This distribution still pins the older base; it does not import
the later upstream migration, synchronize branches or rewrite applied history.

## Existing feature databases

Stop old native-router workers and drain requests before upgrading. Mixed old/new
workers and a rolling upgrade are not verified. Transactions remain atomic per
migration file, not across the complete set; already successful files remain
committed if a later file fails. Unknown legacy attempts are not replayed, and
unreceived remote charges cannot be reconstructed by a schema migration.

The original feature files retain their exact SQL bytes:

| Old identity                         | Namespaced identity                     | SQL SHA-256                                                        |
| ------------------------------------ | --------------------------------------- | ------------------------------------------------------------------ |
| `213_decision_application_attempts`  | `nr-213_decision_application_attempts`  | `5bae9ae34c3d459297911707b177fea4c440fb59f11c2b1d63cf166940165a5f` |
| `214_decision_claude_uncached_input` | `nr-214_decision_claude_uncached_input` | `e62fce4136cb7bcc1adc78cfa18d8eb74b30d083108859aac5888e1d4e5e4773` |
| `215_native_selection_lanes`         | `nr-215_native_selection_lanes`         | `44b816f0644364e0cf04a3f07d765a43cb44d5b57d299053d743f56795a4a56b` |

Reconciliation accepts only exact old version/name pairs and checks required
physical tables, column types, predecessor markers and indexes. It runs within the
existing snapshot and IMMEDIATE safety transaction. Only the marker version
changes; its name and `applied_at`, and known attempt receipts, remain intact.
An unrelated numeric `213` marker is not a feature marker. Duplicate targets,
unknown names and incomplete physical schema fail closed. Namespaced SQL errors
do not use the generic duplicate-column marker-only fallback.

`nr-216_native_attempt_leases` adds `lease_owner`, `lease_expires_at` and
`requested_model`. It removes the exclusive active-key index and retains the
unique execution-child index. Never-started legacy reservations become cancelled;
missing counts/cost become known zero while reported values remain intact. Legacy
started work becomes unknown without replay or invented charges. Historical
`requested_model` stays NULL: a later combo rename cannot recover the original
trusted request scope. Runtime admission and lease ownership belong to the attempt
domain module; this SQL migration alone does not enforce concurrency limits.

`nr-217_tool_continuations` adds `decision_tool_turns` and `decision_tool_calls`.
They retain keyed metadata, exact origin/claim references and bounded lineage;
they do not store messages, arguments, results or signed thinking blocks. Schema
provenance checks include primary/unique keys, required columns, foreign keys,
state/depth/ordinal constraints and indexes. Existing migration bytes and applied
numeric history are unchanged.

The domain APIs atomically reserve a fresh continuation request and claim its
turn. Successful tool-handoff publication or final consumption can share the
application-outcome transaction; failed writes preserve the physical receipt
and do not invent a successful handoff. A started attempt with an expired lease
or uncertain outcome cannot be replayed. Only a provably unstarted cancellation
may release its claim for a fresh request. The 30-minute authority window does not restart on each
turn. Bounded cleanup retains ancestry while a descendant could still publish;
it is not a timed purge or secure-erasure guarantee.

These tables alone do not enable tools, attest that a tool ran or grant tool
permissions. The guarded handler must validate complete provider/client output,
current authorization, cancellation, exact identity and required in-memory
signed replay. Database fixtures do not establish those runtime or live-provider
properties.

## Inventory and packaging

Count core and bundled SQL together:

```sh
rg --files src/lib/db/migrations -g '*.sql' | wc -l
node scripts/check/check-migration-numbering.mjs
```

The documentation count gate walks the migration directories recursively. The
standalone assembler already copies that directory recursively, and npm's source
allowlist includes `src/lib/`. Source/fixture packaging checks are not a successful
production build or evidence of a live migration.

Regression tests use disposable SQLite databases: fresh installs, the exact stable
schema upgrade, legacy feature markers, partial/conflicting ledgers, synthetic
future numeric-slot coexistence, lease backfill and repeat startup. The numeric
`213` coexistence fixture is synthetic, not a copied upstream migration. No live
database, configuration or credential is needed.
