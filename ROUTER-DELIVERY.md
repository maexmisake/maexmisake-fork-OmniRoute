# Native decision router: review delivery

> **26 October local review repair:** 996 selected Node tests, 590 Vitest tests, 19 dashboard tests and 24 private Python harness tests pass. Ordinary model/effort behavior is restored; native admission, crash recovery, scoped quota checks and migration compatibility are repaired. These local changes are not yet published. The full 23-choice pool and default Hermes streaming/tool request remain unfinished; no live compatibility or model-quality claim is made.

This is an opt-in, text/JSON prototype. The real application handler can ask one native decision model to choose an eligible execution model and thinking effort, then make at most one guarded execution. Ordinary defaults and existing combo strategies are unchanged. The live installation has not been modified.

The local text-contract follow-up accepts explicit equal token-limit aliases (`max_tokens` or `max_completion_tokens`) and effort carriers (`reasoning_effort` or `reasoning.effort`). Conflicting, missing or unsupported controls are rejected before dispatch. With exactly one eligible choice in native mode, the existing guarded execution runs without a decision-provider call; response headers identify `sole-eligible` and `no-decision`. This is not a successful Jev selection. Zero eligible choices remain no-route; multiple eligible choices still require the configured native selector. Deterministic selection stays separate. Cost-summary read failures retain unknown status without retrying completed work.

The inspected [official Hermes source](https://github.com/NousResearch/hermes-agent/tree/749cb638ff43f9ce5333c186a1e4f67d473aa4f2) defaults to streaming and can omit an output cap. Those requests remain unsupported here. These text fixtures establish neither installed-Hermes compatibility nor support for streaming, tools or continuation.

Final local text-follow-up validation passes **1054/1054 selected Node tests across 61 files**, including **8/8 independent application-handler review tests**. Direct compiler commands match the actual stable comparison: core passes and strict core retains the same 18 diagnostics byte for byte. Scoped lint and formatting pass; complexity remains 3126/3218 and cognitive violations 1437/1437, with no threshold changes. The earlier 590 Vitest, 19 dashboard and 24 Python results belong to the preceding repair batch and are not added to the Node count. No full-suite, build, live-provider or quality pass is implied.

## Finished, blocked, unverified

- **Finished:** explicit free Zen and preserved paid decision bindings, eligibility and exact dispatch guards, separate decision/execution accounting, bounded sanitized failure diagnostics and offline application tests. The earlier structured-controls checkpoint passed **841/841 across 46 files**. The local review repair expands this to **996/996 across 59 files**, with **590/590 Vitest** and **19/19 structured-dashboard behavior tests**. The preceding free-Zen checkpoint passed 672/672 across 31 files. These are offline correctness checks, with separate independent review.
- **Build blocked:** the unchanged locked SWC dependency rejects this cloud image's ancestor ownership. A runnable production package and package boot are unverified. No security check, dependency or environment setting was weakened.
- **Live unverified:** separate direct provider smokes succeeded, but the prototype has not run end-to-end with real accounts. Retained observations are incomplete and cannot prove full adapter compatibility. Free Zen live compatibility remains unverified. Historical reported 429s do not establish the exact request, account attribution, completed authentication or quota scope. A separate cloud-network proxy denial is not an OpenCode response.
- **Quality unverified:** synthetic routing behavior does not establish better model choices, calibrated confidence or support for the historical full candidate pool. Private research now includes 30 newly curated post-design cases and four replacement SVG assets for offline preparation. These do not recover the original independent held-out set or establish model quality; historical results remain separate.

## Local dashboard settings

The existing Combos page links to `/dashboard/combos/decision`. It edits an existing combo: choose deterministic or native selection, select an exact decision provider/model and connection, explicitly set the Zen free routing guard if needed, and enter model/effort profiles through structured controls. Add or remove profiles, declare supported efforts and capabilities, select existing connections, and choose and reorder allowed profiles for each task. JSON remains an optional advanced view. No candidate pool, quality rank or capability evidence is invented. New profiles begin with unknown declarations; provider/model changes clear their old declarations and connection. Selector choices distinguish listed free from paid contracts without claiming account entitlement. Free Jev is opt-in. Saving settings never runs a model, discovers a remote catalog, validates a key, clears a cooldown or synchronizes cloud state. Protocol support and configured credentials do not establish live readiness.

The dedicated settings endpoints remain authenticated even with dashboard login disabled. Browser mutations retain the normal Origin/CSRF check; delegated provider-tier writes require admin scope. Revision checks reject stale edits, generic combo saves preserve the managed policy, and reload/disable controls recover from invalid or uncertain settings. Cancelling a submitted save does not promise rollback: reload to determine the outcome. Other provider editors can still change or invalidate connection metadata; reload after using them. The runtime retains its final identity/tier fences and does not introduce paid fallback.

The structured controls pass **19/19 UI behavior tests**, including full form-only creation, exact serialized saves, task ordering and removal, unknown declarations, invalid/duplicate profiles, custom task-key preservation, stale and uncertain saves, reload and disable recovery. The repaired application/API sources pass **996/996 selected Node tests**, including the original 46-file selection and 13 added repair/regression files. The exact seven-file release comparison reproduces nine original regressions and now passes all original 98 cases plus one migration-count case. Both actual release baseline and repair pass 590 Vitest tests; core TypeScript passes and strict core retains 18 byte-identical diagnostics. Earlier API/database review reproduced 48 overlapping cases; those counts are not added together as coverage. Component tests check labels and behavior, not actual browser appearance or screen-reader operation. The smaller core compiler and broader scoped compiler are separate checks. The preceding paired production builds stopped at the unchanged SWC native-cache trust error before compilation; this structured-controls milestone did not repeat that known failure. A runnable package, live free-Jev compatibility and model-selection quality remain unverified.

## Modes and exact bindings

| Mode                  | Behavior                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary combos       | Existing behavior; this prototype does not activate itself.                                                                                                                                                                          |
| Bounded deterministic | Eligibility first, explicit task preference order, zero decision calls and at most one execution.                                                                                                                                    |
| Bounded native        | Eligibility first. Two or more options: one Choice decision, then at most one exact execution. One option: explicit sole-eligible execution with no decision. Zero options or an invalid, unknown, refused or denied decision: stop. |

| Selector provider config ID             | Exact requested and required returned model ID |
| --------------------------------------- | ---------------------------------------------- |
| `typesafe`                              | `jev-1.14.0`                                   |
| `openrouter`                            | `typesafe/jev-1.14-20261014`                   |
| `vercel-ai-gateway`                     | `typesafe-ai/jev`                              |
| `opencode-zen` (explicit free opt-in)   | `jev-1.13-free`                                |
| `opencode-zen` (preserved paid binding) | `jev-1.13`                                     |

Provider and model form one strict operator-stored binding. Cross-provider spellings, unreviewed aliases and client-supplied activation reject before dispatch. Free Zen requires an explicit `jev-1.13-free` binding and exactly `{ systemOneTier: "free" }` connection metadata. That tag is our routing guard, not provider entitlement. It is retained and rechecked during preparation, credential selection and final dispatch; a paid model or connection cannot silently substitute for it. A missing or mismatched returned identifier cannot authorize execution. Vercel's generic ID is a floating alias, not an immutable underlying model revision. The real OpenRouter smoke requested `typesafe/jev-1.14` and returned the dated ID; the **dated request binding itself has only official-contract synthetic validation**. The preserved paid Zen binding does not authorize a paid Zen test.

Separate `POST /v1/systemone` and `GET /v1/systemone/models` routes provide native passthrough/discovery for these providers. Passthrough supports Noul, Choice and Score; the automatic selector deliberately uses Choice. Direct TypeSafe reuses the existing provider connection and shared guarded transport/catalog parser. Its native `models[].name/description` shape is projected; release_date is not projected. Bare aliases retain their earlier routes and gain no TypeSafe fallback. Vercel evaluate/Decisions and direct OpenAI Decisions are different, deferred contracts.

Execution support remains OpenAI API-key text/JSON and Claude OAuth `claude-opus-5-5` at medium/high effort. Explicit capability/effort profiles and exact connection bindings are required. Antigravity, Codex and other Claude pairs remain unsupported here. Catalog presence is not account entitlement or capability evidence; the historical 23-candidate pool was not replaced or declared supported.

## Guards and accounting

Native mode permits 2–32 eligible options by default (configurable up to 255), one decision attempt, one execution attempt and stop-on-decision-failure. Request/response bytes are bounded to 64 KiB for the native stage; its timeout is at most 10 seconds within the overall 30-second maximum. The selector receives task labels, flags and counts rather than raw prompts/private profile evidence. Its confidence grants no permissions and is not measured correctness.

The existing client authentication, stored connection selection, endpoint/header fence, capacity, authorization rechecks and per-stage journal remain the call path. Native 401/402/403/429/451 stops without account/provider/global/deterministic fallback. Queued policy changes, cancellation and committed output prevent follow-on execution. No bootstrap, quota usage probe, refresh, hidden chat substitute or second gateway was added. Unsupported streaming, images, tools/continuations, capped/quota-scoped keys and proxy/TLS configurations fail closed in this bounded lane.

Native admission now permits four active local stage leases per key. Leases expire after 45 seconds within the existing 30-second request budget; expiry releases occupancy and never proves a remote call stopped. Reserved work that never started may be cancelled with zero usage; started work retains unknown usage, cannot be replayed and may accept only an original-owner late receipt. Owner capabilities are not projected in public journal reads. Matching financial/token liabilities remain fail-closed, including requested-combo token limits; unrelated and uncapped ordinary traffic is preserved. Unknown receipts are not automatically adjudicated across cap-reset windows. Native mutation/dispatch requires supported file-backed SQLite storage; sql.js, memory and unknown adapters reject this lane. Actual multiprocess proof covers better-sqlite3 only.

Unmanaged native selector/execution/catalog paths now honor active exclusive account leases and recheck queued dispatch. Managed session keys/headers are rejected where unsupported. These observations do not provide globally atomic acquisition across both lease systems.

Bundled native SQL uses its own `nr` namespace, with exact legacy-ledger/physical-schema compatibility checks, unchanged original SQL bytes and preserved receipts/timestamps. Stop old workers before upgrading; no safe rolling overlap or production migration is claimed. See [migration compatibility and dated correction](docs/architecture/NATIVE_ROUTER_MIGRATIONS.md). The earlier pinned trees ended at 212; that did not establish current branch state. Upstream commit `860ebfad6e357cbaf0d918c19ae790de0f95ed69`, merged October 25 UTC, added `213_api_key_preferred_connections.sql`, verified at `db6db55ba8bca51a96d347b9f3cc6399725f2c4b`. Namespacing avoids this confirmed numeric overlap. No upstream sync or live upgrade is implied.

Decision and execution receipts/costs remain separate with one logical RPM charge. Missing usage/cost remains unknown; reported zero stays zero. TypeSafe's inspected native contract does not document an exact USD receipt. OpenRouter numeric usage.cost and Vercel decimal-string provider_metadata.gateway.cost are tested documented formats, not recovered live representations. Ordinary standalone history/cost writers remain best effort with inherited deduplication; they are not an atomic financial ledger. Remote bills never received and ancillary quota preflight cancellation remain limitations.

The fixed truthful `OmniRoute-SystemOne/1.0` identifier names this transport, without browser/OpenCode impersonation. Bounded RFC9457/nested diagnostics use canonical sanitization and known-value/account-form redaction; raw bodies/HTML are not returned. This is not universal detection of unidentified private prose. An HTTP status alone does not identify which provider, edge or intermediary emitted it; diagnostic prefixes therefore say "Upstream returned HTTP". A presented key or 429 does not prove key validity, completed authentication or account-specific quota. The separate legacy Jev client and credential validator are unchanged.

## Reproduce offline in an isolated checkout

Use the installed project dependencies and isolated synthetic setup; do not copy a live database, .env, plugins or credentials. From this checkout:

```sh
env -i PATH="$PATH" OMNIROUTE_OFFLINE_AUDIT=local-fixtures \
  NODE_OPTIONS="--import=$PWD/scripts/ad-hoc/native-router-offline-guard.mjs" \
  TSX_DISABLE_CACHE=1 DISABLE_SQLITE_AUTO_BACKUP=true \
  API_KEY_SECRET=synthetic-fixture-secret \
  node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts \
  --test --test-reporter=tap --test-concurrency=4 \
  tests/integration/decision-native-selector.test.ts \
  tests/unit/db/native-decision-handover.test.ts \
  tests/unit/decision-paid-native-bindings.test.ts \
  tests/unit/decision-paid-observed-subset.test.ts
```

The actual-handler fixture's `configure()` function creates a temporary database, synthetic keys, loopback providers and an explicit stored combo policy (`enabled:true`, `applicationMode:"bounded-v1"`, deterministic/native selection, exact connection bindings). All activations used only isolated synthetic fixtures, including the dashboard settings API tests; no live combo was activated. Do not treat its synthetic profiles as live model evidence. The audit preload rejects external JS fetch/socket dispatch and is inherited by child Node processes; it is a test safeguard, not an OS-wide firewall or production startup component.

The nine retained-subset checks preserve six Noul/Choice observations and reject three incomplete Score fixtures whose legends were not retained. They do **not** establish that live responses lacked legends. Complete raw response bodies, original cost representations/source paths and other discarded fields cannot be reconstructed. Defensive refusal fixtures prove safe stopping, not observed Jev refusal behavior.

Core TypeScript passes; strict core retains the same 18 inherited diagnostics. Complexity thresholds remain unchanged. The SWC build failure comes from separate locked `@swc/core` through next-intl; Next's WASM fallback alone does not remove it, and no supported unchanged-lock full JS/WASM build route was established. A compatible cloud runner must repeat paired full builds, then package/no-network boot checks on success.

## Delivery and source history

The delivery destination is `maexmisake/maexmisake-fork-OmniRoute`, branch `feat/native-router-delivery-20261024`. The October 25 publication record verified snapshot `de2055251341cb41190e8a4ca68cb36f2a901ca3`, tree `ccd5ba750eb7b2f87e623a84ae1bba6ce22ca28b`, content-identical to preserved local `82768a81df252fcb3d9ed6e19a4e22b02c543407`. It includes the free Zen binding, dashboard editor and structured controls. Earlier publication snapshot `7d396a43294f06a5996c5d01f88d56bf3578c1d5` and all original local milestones remain preserved. The October 26 review repair is local commit `73797d79de210d255d65bc2425c54ca1d5dfec56`; its text-contract follow-up is on a separate local branch. No new publication, remote merge or deployment was attempted in this repair phase. Re-read remote heads before any future publication.

The original draft PR/head, local milestone history and published snapshots remain intact. The branch is based on published stable v3.8.52 `ad6f33f66bda34eba98645d3bfdabbde294bc843`; it is not a merge-ready update to the divergent fork release target. No sync, rebase, remote merge or force push is included.

Current changes are **prepared, not published**. Transfer must recheck the target head and preserve any new remote work; ancestry differs because the earlier managed publication was a snapshot. No PR, upstream submission, deployment, live configuration, new credential access or additional provider call is included. Detailed research, captures and budget records remain in private Gravewire, never in this public implementation tree.

Source: [application selection](src/lib/decisionPolicy/applicationSelection.ts), [explicit config bindings](src/lib/decisionPolicy/applicationCombo.ts), [registry](open-sse/config/systemOneRegistry.ts), [transport](open-sse/handlers/systemOneTransport.ts), [journal](src/lib/db/decisionAttempts.ts), [handler acceptance](tests/integration/decision-native-selector.test.ts).
