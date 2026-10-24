# Native decision router: local delivery guide

This branch contains an opt-in, text/JSON automatic-routing prototype. The actual chat handler can make one native System One selection over eligible model-and-effort pairs, then make at most one guarded execution of the valid chosen pair. Ordinary defaults and existing combo strategies are unchanged. It is not production-ready or evidence of improved model-selection quality.

## Branch and ancestry

- Delivery branch: `feat/native-router-delivery-20261024`.
- Frozen feature commit: `a582ee575296099248d995a59dd2b577b425c9b2`.
- Exact immediate baseline: `1e53f94268cbe235536ee57be7591122abaef2ca`.
- Published stable ancestor: v3.8.52, `ad6f33f66bda34eba98645d3bfdabbde294bc843`.
- Original PR head `d075d8d8c5b440a13bd1eff5736d3ee0cfe82dec` remains preserved separately. This delivery does not rewrite it or merge remote branches.

The stable integration chain retains the native transport foundation (`60182c8c0e`), offline policy (`fde986c4a8`), dispatch guards (`413bd72eae`), application admission (`066685c6e7`), permitted path (`084b15d16b` plus deadline/bearer fixes), Claude contracts (`4d09a99bee`, `1e53f94268`) and native application selection (`a582ee5752`). No feature scope was added during consolidation; the only additions are this guide and an explicitly loaded offline audit preload.

The configured fork target at audit time is `88c1e3342b44978a72ce75beb0cc509cc83a93d2`. It is not an ancestor of this stable-based branch. Their merge base is `fc5e2bccd4f70fecf5aab94dfb8136c74ab5a21b`, with 5,840 fork-side versus 15 stable/feature-side commits before consolidation. Publishing a review branch would not update that target. This is not a merge-ready PR against the divergent fork release branch; target alignment needs separate review.

## Implemented modes and boundaries

| Mode                  | Behavior                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary combos       | Existing behavior; no automatic activation of this prototype.                                                                                                              |
| Bounded deterministic | Eligibility first, then explicit task preference order; zero decision calls, at most one execution.                                                                        |
| Bounded native        | Eligibility first, one native decision, then at most one exact execution. Invalid/refused/auth-failed/unknown decisions stop; no chat substitution or retry/fallback loop. |

The earlier foundation also supplies separate `POST /v1/systemone` and `GET /v1/systemone/models` passthrough/catalog endpoints, with registry bindings for OpenCode Console, the Vercel native System One path and OpenRouter compatibility. Those routes retain their own dispatch and accounting behavior; they are distinct from bounded automatic selection. Their source/fixture support is not live provider compatibility. Direct TypeSafe and OpenAI Decisions transports are not added by consolidation.

Native selection in this application supports only `opencode-zen/jev-1.13`, using its separate stored Console API-key connection and the documented System One endpoint. Other standalone decision adapters are not enabled as application selectors by this branch. The limited-time free alias is also not enabled in this bounded mode.

Execution support remains OpenAI API-key text/JSON and Claude OAuth `claude-opus-5-5` at medium/high effort. Explicit candidate profiles and exact connection bindings are required; catalog presence is not entitlement or proof of capability. Antigravity, Codex and other Claude pairs remain unsupported here. The historical 23-candidate pool was not silently replaced or declared supported.

Native mode requires 2–32 eligible options by default (configurable up to 255), one decision attempt, one execution attempt and stop-on-decision-failure. Fewer than two options is no-route. Native-selector request/response size is bounded to 64 KiB; selector timeout is at most 10s and within the overall 30s maximum. The selector sees task labels, flags and counts rather than raw prompts/private profile evidence. Its confidence is not calibrated correctness or authorization.

Decision and execution have distinct durable receipts and reported costs, with one logical RPM charge. Unknown usage/cost remains NULL. Handover is atomic; queued policy changes, cancellation and exact physical identity remain guarded. This is not financial escrow, remote exactly-once execution or automatic recovery of billing never received.

This bounded lane rejects streaming, images, tools/continuations, automatic OAuth refresh, quota-scoped keys, financial/token caps, unsupported proxy/TLS-fingerprint/insecure-TLS settings and live quota preflight. Do not bypass those rejections or fall back to another route to obtain success.

## Reproduce only in an isolated test instance

Use the saved isolated checkout and existing installed dependencies, Node24.19.0/TypeScript6.0.3. Do not copy a live database, `.env`, plugins or credentials into it. Do not run dependency install scripts or a live server as a smoke test.

From the checkout root, this verified command invokes the real application handler with local synthetic providers:

```sh
env -i PATH="$PATH" OMNIROUTE_OFFLINE_AUDIT=local-fixtures \
  NODE_OPTIONS="--import=$PWD/scripts/ad-hoc/native-router-offline-guard.mjs" \
  TSX_DISABLE_CACHE=1 DISABLE_SQLITE_AUTO_BACKUP=true \
  API_KEY_SECRET=synthetic-fixture-secret \
  node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts \
  --test --test-reporter=tap --test-concurrency=4 \
  tests/integration/decision-native-selector.test.ts \
  tests/unit/db/native-decision-handover.test.ts
```

The test setup creates a temporary DATA_DIR, fake client/provider keys, local mock endpoints and an operator-stored combo policy. Its `configure` function demonstrates the only activation used in validation: `enabled:true`, `applicationMode:"bounded-v1"`, explicit `selection.mode:"native"`, the pinned selector connection, exact candidate/connection profiles and one-attempt bounds. The client request only names that combo; request fields cannot enable native mode. `configure("deterministic")` demonstrates the separate baseline. Do not copy the synthetic capabilities into a real candidate pool as evidence.

The audit preload rejects external JS fetch/socket dispatch, permits explicit 127.0.0.1 fixtures in this mode, and permits filesystem IPC. It is not part of application startup and is not an OS-wide firewall. The command inherits the preload through NODE_OPTIONS so spawned Node database-check processes are guarded too. Production builds use its default no-network mode, inherited by child Node processes through NODE_OPTIONS. Do not load it in a live installation.

Relevant code: [application orchestration](src/lib/decisionPolicy/applicationCombo.ts), [native selection binding](src/lib/decisionPolicy/applicationSelection.ts), [shared native transport](open-sse/handlers/systemOneTransport.ts), [shared capacity](open-sse/handlers/systemOneCapacity.ts), [journal](src/lib/db/decisionAttempts.ts), [migration 215](src/lib/db/migrations/215_native_selection_lanes.sql), [actual-handler acceptance](tests/integration/decision-native-selector.test.ts).

## Validation status

- Feature acceptance: 127 targeted tests and 793 selected regressions passed, plus one guarded TLS connector policy test. These are synthetic behavior checks, not live handshake or quality evidence.
- Independent feature review: 38 handler cases, six adversarial probes and three journal cases passed in separate runs; no blocker for local preservation remained.
- Delivery command above: 41/41 passed using the committed preload. Build/packaging unit checks: 69/69 at both feature and exact baseline. Source package dry-run and policy checks pass on both.
- Production build: blocked on both commits before compilation by the same installed SWC native carrier/cache trust failure. Default, isolated custom cache and documented temporary-materialization settings could not load the addon. No reinstall, native-security bypass, source workaround or resource-limit increase was used. There is no built standalone artifact; full package assembly/boot remains unverified.
- Separate compiler evidence remains: core 0 diagnostics; strict core 18 inherited diagnostics unchanged. Expanded route graph 713 versus 722 baseline after the shared limiter's signal types were corrected; it is still a failed check. Next's build configuration ignores TS errors, so even a future successful build will not erase these failures.
- Quality thresholds were not raised. Four SVG fixtures and 30 held-out tasks remain missing. No real provider inference, credential access, paid usage or deployment occurred.

To unblock release validation, use a cloud build image where the installed verified SWC native carrier loads under its normal filesystem ownership rules, then repeat the same offline production build on both commits, assemble/validate the actual package and run isolated package boot checks. Do not label source package-policy success as runnable artifact success.

## Publication boundary

This proposed public-fork delivery contains code, synthetic tests and sanitized operator documentation. Private research, manual assets, screenshots, actual configuration and build captures stay in the separate private research repository. A local scan/manual diff review found no real credentials or private endpoints introduced by this delivery; the repository gitleaks check was unavailable and reported SKIP, not a clean scan.

An authorized push would create only `feat/native-router-delivery-20261024` in `maexmisake/maexmisake-fork-OmniRoute`. No draft PR is proposed as part of that push while the release target is divergent and the build remains blocked. No upstream submission, target-branch update or deployment is included. Nothing has been pushed.
