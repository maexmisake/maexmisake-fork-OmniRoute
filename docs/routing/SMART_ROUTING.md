---
title: "Smart Routing Task Context and Client Intent"
version: 3.8.52
lastUpdated: 2026-10-27
---

# Smart routing task context and client intent

The smart-routing branch keeps the original model/effort profiles and separates
hard eligibility from optional native selection. Its local intent and difficulty
heuristics are not measured model quality or calibrated success probabilities.

## Task privacy

The default native selector receives task labels, bounded structural counts and
capability/effort metadata. It does not receive task text. A selector cannot assess
task details it has not received; a successful Choice response alone does not prove
good routing.

An operator can choose **Latest user task with client consent** in the decision
routing editor, acknowledge external transmission and set a bound from 1 to 2,048
UTF-16 code units. The stored `selection.decisionContext` is validated by
[`configuration.ts`](../../src/shared/decisionPolicy/configuration.ts) and
[`taskContext.ts`](../../open-sse/services/decisionPolicy/taskContext.ts).
Changing the selected decision binding or connection clears the editor acknowledgement.

That operator setting alone does not disclose text. A client must additionally send
`x-omniroute-decision-context: task-text` on the particular request. Without both
gates, the selector receives the local summary. The header is an internal routing
control and is forbidden as a configured upstream header.

With both gates, only the exact latest user task is added to decision state.
System, developer, assistant, tool and previous user content are excluded from
that context. Oversized tasks reject before a physical decision call; no truncated
excerpt is substituted. This disclosure does not apply to the separately selected
execution provider, which receives the authorized execution conversation.
Authenticated tool continuations retain their selected identity and do not disclose
the prior user task for another decision. The receipt inspector exposes fixed
context reason codes, not the text.

## Client intent

Profiles may include optional `selectionGuidance` of at most 1,000 characters.
This is an operator preference, separate from capability evidence and quality
measurements. It stays local unless the operator separately acknowledges sharing
guidance with the exact decision provider, model and connection. The stored
`selection.guidanceDisclosure` binds that acknowledgement to the destination;
missing or mismatched consent never serializes guidance into Choice criteria.
The editor clears acknowledgement when the destination or profile payload changes.
This acknowledgement is separate from per-request task-text consent. Never put
secrets in guidance. The existing total native request byte limit still applies.

[`requestFacts.ts`](../../open-sse/services/decisionPolicy/requestFacts.ts) separates
task intent from difficulty. Quoted text, block quotes and fenced payloads do not
replace the surrounding instruction. Informational questions about models remain
informational. Explicit effort remains an eligibility constraint; a local heuristic
does not erase it or translate one provider's effort ladder into another's.

The optional, uninstalled
[Hermes effort-delegation fixture](../../scripts/ad-hoc/hermes-effort-delegation/README.md)
demonstrates unset-effort delegation separately from explicit Medium/High and
reasoning-off. It requires its documented exact source pin and guard patch.
Fixture success does not establish a full Hermes agent run.

## Evidence boundaries

Before selection,
[`applicationAvailability.ts`](../../src/lib/decisionPolicy/applicationAvailability.ts)
uses existing local quota observations, operator quota thresholds, connection
cooldowns/terminal states, model lockouts and configured provider breakers. A busy
half-open probe also excludes that provider. Key connection restrictions apply
before a candidate is offered. Only the operator's existing eligible profile order
can supply an alternative; a sole eligible profile needs no decision call. Missing
quota remains unknown. This preflight performs no provider probe or credential refresh.

Automatic execution keeps the normal breaker and model-cooldown gates even though
its selected connection is pinned. A provider becoming unavailable after Choice
cannot turn that pin into an override. The application lane still permits one
physical execution by default. An operator can explicitly enable a directed failover
chain in **Configured execution failover**, with two to five total execution attempts.
Each transition names existing profile IDs and allowed failure scopes in
`retry.transitions`. There is no second native decision and no ambient fallback.

Supported scopes are `account-quota`, `account-rate-limit`, `model-unavailable` and
`provider-unavailable`. Account scopes require a different configured connection;
model scope requires a different model or provider; provider scope requires a
different provider. Exact model/effort profiles may have distinct IDs for separate
accounts, but duplicate bindings to the same connection reject. Operators must bind
account alternatives to the intended separate quota scopes; different connection IDs
alone do not establish independent upstream account quotas.

[`retryPolicy.ts`](../../open-sse/services/decisionPolicy/retryPolicy.ts) accepts only
closed, completed rejection shapes and known provider-specific error types. A bare
status, ambiguous scope, refusal, access denial, partial/generated output or unknown
transport completion never grants retry permission. This is not a claim that every
provider error format is classified. Unknown cost stays on the rejected attempt's
receipt and keeps total spending unknown. `Retry-After` and one shared deadline apply;
eligibility and full dispatch authority are checked again after waiting.

[`decisionAttempts.ts`](../../src/lib/db/decisionAttempts.ts) atomically authorizes
one retry child per completed rejection. Every physical attempt has its own receipt,
while logical RPM is counted once. Trusted tool continuations retain their exact
origin and cannot enter this retry chain. A verified rejected execution may update
its old native-selection snapshot's operational `apiKeyHealth`; credentials, policy,
key permissions and destination remain fenced. Every new execution snapshots its
entire current authority again, including current health metadata.

[`decisionPolicyMetrics.ts`](../../scripts/router-eval/decisionPolicyMetrics.ts)
computes offline metrics from a result artifact and a separate label artifact.
Both carry the suite hash; case, input and response hashes must match. These hashes
do not authenticate externally supplied results or establish a held-out split.
Task grades may describe completed responses or negative settled execution failures;
unknown and unrun outcomes stay ungraded. Coverage is reported against the whole cohort.

Calibration requires an explicit forecast of **task success**, not native Choice
confidence. The report includes Brier score, ten-bin expected calibration error,
misroute/fallback denominators, reported decision latency percentiles, separate
decision/execution costs and adjacent-turn session churn. Missing cost is unknown;
unrun cases cannot invent attempts or bills. Churn does not prove cache reuse.
The report never supplies counterfactual savings or a promotion decision.

This example performs no inference and reports one explicitly unrun synthetic case:

```bash
node --import tsx/esm scripts/router-eval/decisionPolicyMetrics.ts tests/fixtures/decisionPolicy/metrics-example-run.json tests/fixtures/decisionPolicy/metrics-example-labels.json
```

The example retains the original candidate IDs, supplies no quality labels and
cannot establish selection accuracy, measured savings or independent quality.

Offline handler and component tests verify consent, bounds, identities and wire
contracts. They do not establish routing accuracy, savings, live entitlement,
every client protocol or full-agent compatibility. Decision spending, execution
spending and unknown costs remain separate. Historical checkpoint evidence is
recorded in [the native-router report](NATIVE_ROUTER_COMPLETION.md); a new source
tree requires its own build and browser acceptance.

The architecture review consulted
[hermes-jev-routing at 06a53646587c](https://github.com/apoapostolov/hermes-agent-awesome-plugins/tree/06a53646587c33174a0fbfbb3713eca90bbb8586/public/hermes-jev-routing)
by Apostol Apostolov (MIT). This work copies no plugin source and installs or runs
no plugin. Its same-provider middleware and supported Desktop configuration boundary
are reference patterns; the personal edition's private-internal rebinding is not
used here.
