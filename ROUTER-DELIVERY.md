# Native decision router: review delivery

This is an opt-in, text/JSON prototype. The real application handler can ask one native decision model to choose an eligible execution model and thinking effort, then make at most one guarded execution. Ordinary defaults and existing combo strategies are unchanged. The live installation has not been modified.

## Finished, blocked, unverified

- **Finished:** explicit free Zen and preserved paid decision bindings, eligibility and exact dispatch guards, separate decision/execution accounting, bounded sanitized failure diagnostics and offline application tests. The current dashboard/native selected suite passed **841/841 across 46 files**, plus 11/11 UI cases. The preceding free-Zen checkpoint passed672/672 across31 files. Independent checks and final manifest review found no remaining blocking defect in this narrow local scope.
- **Build blocked:** the unchanged locked SWC dependency rejects this cloud image's ancestor ownership. A runnable production package and package boot are unverified. No security check, dependency or environment setting was weakened.
- **Live unverified:** separate direct provider smokes succeeded, but the prototype has not run end-to-end with real accounts. Retained observations are incomplete and cannot prove full adapter compatibility. Free Zen live compatibility remains unverified. Historical reported 429s do not establish the exact request, account attribution, completed authentication or quota scope. A separate cloud-network proxy denial is not an OpenCode response.
- **Quality unverified:** synthetic routing behavior does not establish better model choices, calibrated confidence or support for the historical full candidate pool. Missing held-out tasks and SVG fixtures remain missing.

## Local dashboard settings

The existing Combos page links to `/dashboard/combos/decision`. It edits an existing combo: choose deterministic or native selection, select an exact decision provider/model and connection, explicitly set the Zen free routing guard if needed, and enter the model/effort profiles and task preferences. Profiles use an advanced JSON editor with a readable model/effort summary and explicit connection selectors; no candidate pool, quality rank or capability evidence is invented. Free Jev is opt-in. Saving settings never runs a model, discovers a remote catalog, validates a key, clears a cooldown or synchronizes cloud state. Protocol support and configured credentials do not establish account entitlement or live readiness.

The dedicated settings endpoints remain authenticated even with dashboard login disabled. Browser mutations retain the normal Origin/CSRF check; delegated provider-tier writes require admin scope. Revision checks reject stale edits, generic combo saves preserve the managed policy, and reload/disable controls recover from invalid or uncertain settings. Cancelling a submitted save does not promise rollback: reload to determine the outcome. Other provider editors can still change or invalidate connection metadata; reload after using them. The runtime retains its final identity/tier fences and does not introduce paid fallback.

This local milestone passed **841/841 selected Node tests across 46 files** and **11/11 UI behavior tests**; independent review also reproduced 48 API/database/authorization cases and the 11 UI cases. These suites overlap and are not added together as coverage. The broader UI/API typecheck has the same 940 inherited diagnostics as the exact parent, with no added diagnostic identities; the smaller core check is separate. Production builds on the exact parent and this working source both stop at the unchanged SWC native-cache trust error before compilation. Browser appearance, a runnable package, live free-Jev compatibility and model-selection quality remain unverified.

## Modes and exact bindings

| Mode                  | Behavior                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary combos       | Existing behavior; this prototype does not activate itself.                                                                                                         |
| Bounded deterministic | Eligibility first, explicit task preference order, zero decision calls and at most one execution.                                                                   |
| Bounded native        | Eligibility first, one Choice decision over allowed model-and-effort options, then at most one exact execution. Invalid, unknown, refused or denied decisions stop. |

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

The approved destination is `maexmisake/maexmisake-fork-OmniRoute`, branch `feat/native-router-delivery-20261024`. Its last verified remote head is publication snapshot `7d396a43294f06a5996c5d01f88d56bf3578c1d5`, tree `6362a2e42b64df151f9b630b3c98ef19faf5cd5e`, content-identical to preserved local `49cf693908abc613c215c620a6ebc80241265b3c`. Follow-ups are `623329ad6e7bf9be192510fec3b8087bbc25393d` and `dc1da5ae79be4d37e141d95fbca63f8f54d450a9`. The preserved follow-ups culminate at `a76e7a8e42ffb7bd06c2dd86f2b2a5fc5bdf58b5`. The current local work includes the explicit guarded free Zen binding, handler/schema regression coverage, neutral error-origin wording, the local dashboard settings editor, atomic revision checks and management authorization/subtree ownership guards; earlier local commits remain intact.

The original draft PR/head, local milestone history and published snapshots remain intact. The branch is based on published stable v3.8.52 `ad6f33f66bda34eba98645d3bfdabbde294bc843`; it is not a merge-ready update to the divergent fork release target. No sync, rebase, remote merge or force push is included.

Current changes are **prepared, not published**. Transfer must recheck the target head and preserve any new remote work; ancestry differs because the earlier managed publication was a snapshot. No PR, upstream submission, deployment, live configuration, new credential access or additional provider call is included. Detailed research, captures and budget records remain in private Gravewire, never in this public implementation tree.

Source: [application selection](src/lib/decisionPolicy/applicationSelection.ts), [explicit config bindings](src/lib/decisionPolicy/applicationCombo.ts), [registry](open-sse/config/systemOneRegistry.ts), [transport](open-sse/handlers/systemOneTransport.ts), [journal](src/lib/db/decisionAttempts.ts), [handler acceptance](tests/integration/decision-native-selector.test.ts).
