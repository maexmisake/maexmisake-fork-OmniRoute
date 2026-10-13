---
title: System One (native typed decisions) — contracts and verification status
description: What the native System One integration assumes about each backend, what has been proven, and what is still unverified.
---

# System One (native typed decisions)

System One models answer **typed questions** — `noul` (yes/no), `choice` (one
option) and `score` (a level) — about a supplied `state`, returning calibrated
probabilities instead of prose. They are not chat models and are never
dispatched by a chat executor.

This document records the **contracts the integration is built on** and, just as
importantly, **which of them have been verified from this checkout and which
have not**. Read it before changing an endpoint, a limit or a price in
`open-sse/config/systemOneRegistry.ts`.

> **Status: no live verification.** Every wire contract below is derived from
> vendor documentation. No request in this work reached a real System One
> backend from this checkout (no network, no credentials, no Docker — see
> [Verification status](#verification-status)). Each registry entry carries
> `contractVerified: false` for exactly this reason.

## Surface

| Surface                           | Implementation                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/systemone`              | `src/app/api/v1/systemone/route.ts` → `src/app/api/v1/systemone/dispatch.ts` → `open-sse/handlers/systemOne.ts`                     |
| `GET /v1/systemone/models`        | `src/app/api/v1/systemone/models/route.ts` → `open-sse/handlers/systemOneModels.ts` (+ `open-sse/handlers/systemOneCatalog.ts`)     |
| Backend registry / target rules   | `open-sse/config/systemOneRegistry.ts`                                                                                             |
| Endpoint resolution and transport | `open-sse/handlers/systemOneTransport.ts`                                                                                          |
| Answer parsing / request limits   | `open-sse/services/typesafe/systemOneAnswers.ts`                                                                                   |
| API-key category                  | `systemone` in `src/shared/constants/endpointCategories.ts` (covers both routes)                                                   |
| Model capability                  | `systemone` in `src/shared/constants/modelSupportedEndpoints.ts`; `decision` / `decisions` normalize onto it                        |

Decision-only models are kept out of the unified `/v1/models` catalog and
rejected on chat paths (`src/lib/providerModels/decisionOnlyChatGuard.ts`,
`src/app/api/v1/models/catalogModelPolicy.ts`), so `GET /v1/systemone/models` is
the only place a client can discover them.

## Request and answer contract

Request envelope (validated by `validateSystemOneRequestBody`, then by
`validateSystemOneBackendBody` for the selected backend's own limits):

```json
{
  "model": "jev",
  "state": "the material the questions are about",
  "questions": {
    "urgent": { "type": "noul", "instructions": "Is this urgent?" },
    "route": { "type": "choice", "criteria": { "billing": "money", "tech": "software" } },
    "severity": { "type": "score", "criteria": ["low", "medium", "high"] }
  }
}
```

Answers are preserved as the backend returns them — every answer type with its
`probabilities`, `confidence` and reported `usage` (`parseSystemOneAnswers`). A
body that answers no question, or answers one with an out-of-range probability,
is a `502` contract violation rather than an empty success.

`state` is never truncated, rewritten or logged, and no error message on this
path echoes it: a decision request routinely carries the operator's own data,
and some upstreams echo it (or the request key) back inside an error body. Only
the status plus a short, identifier-shaped upstream error code is passed
through.

## Registered backends

| Backend           | Provider id         | Decision endpoint                                   | Catalog endpoint                                              | Key required |
| ----------------- | ------------------- | --------------------------------------------------- | ------------------------------------------------------------- | ------------ |
| OpenCode Zen      | `opencode-zen`      | `https://opencode.ai/inference/v1/systemone`        | `https://opencode.ai/zen/v1/models`                           | yes          |
| Vercel AI Gateway | `vercel-ai-gateway` | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `https://ai-gateway.vercel.sh/typesafe/v1/models`             | yes          |
| OpenRouter        | `openrouter`        | `https://openrouter.ai/api/v1/systemone`            | `https://openrouter.ai/api/v1/models?output_modalities=decisions` | yes       |

All six URLs are **documentation-derived and unverified**. Each is overridable
per provider connection (`providerSpecificData.systemOneUrl` /
`systemOneModelsUrl`) precisely because vendors move these paths, but an
override must be `https`, carry no embedded credentials, and resolve to a host
on that backend's own allowlist — the request carries the operator's credential,
so an arbitrary host would be a credential-exfiltration path. The decision
override and the catalog override are independent: one cannot silently redirect
the other.

A separate, older client exists for the `jev` **combo strategy**
(`open-sse/services/typesafe/systemOne.ts`, provider `typesafe`, host
`api.typesafe.ai`). It is choice-only and is not part of this native route; the
two do not share credentials.

## Routing rules

- A **provider-qualified id** (`openrouter/typesafe/jev-1.13`) pins that one
  backend: one candidate, no cross-provider fallback, and an unsupported prefix
  fails closed instead of being reinterpreted as a model id elsewhere.
- A **bare alias** (`jev`) fans out across configured backends, bounded by
  `SYSTEMONE_MAX_FALLBACK_CANDIDATES` (3), cheapest documented first.
- Within one candidate, connections of the same backend rotate first, bounded by
  `SYSTEMONE_MAX_CONNECTION_ATTEMPTS` (3), each selection excluding the
  connections already attempted.
- Fallback happens only on a status that says something about the account
  (`401`, `402`, `403`, `429`) or availability (`408`, `5xx` except `501`/`502`).
  A caller-fault status (`400`, `413`, `415`, `422`) and the proxy's ambiguous
  `502` fail closed — `502` covers both a contract-violating success body and a
  transport failure, and the first would repeat on every account.
- The calling key's model rules are re-checked per candidate against the
  canonical `<provider>/<model>` id before a credential is selected, so routing
  cannot widen what the key may reach.
- A **free-tier alias** (`jev-free`) resolves only to free-tier model ids and is
  dispatchable only on a connection the operator explicitly tagged
  `providerSpecificData.systemOneTier: "free"`. That connection still carries
  its normal Zen API key; the tier tag prevents paid fallback, not authentication.
  It can never cross to a paid backend or a paid account.

## Cost and quota

Accounting reuses the existing writers: one `call_logs` row per attempt, one
`usage_history` row per success (so API-key budgets and usage limits see
decisions), and a cost entry **only when the cost is known**.

Cost provenance is explicit, in order: the upstream's reported `usage.cost` (a
reported `0` is a *known* zero), then the operator's pricing row / the pricing
resolver, otherwise **unknown** — surfaced as `X-OmniRoute-Cost-Status: unknown`
with no cost header, never as `0`. No backend publishes a per-token System One
rate that has been verified from here, so `PUBLISHED_PRICING` in the registry is
deliberately empty.

Two quota caveats, both unverified and both relevant to capacity planning:

- **A decision key may share an account-wide limit.** On a gateway the same
  credential pays for chat and decisions, so a decision request can consume (or
  be blocked by) the same account quota as chat traffic. Nothing here isolates
  them; connection cooldown and the existing quota preflight are what protect
  the account.
- **OpenCode Zen's Jev Free is a limited-time free model with a client
  contract restriction.** It is the only free-tier System One model documented
  on any backend. Treat it as capacity that can disappear without notice, and
  do not assume a gateway-proxied call qualifies for it — which is the second
  reason a free alias must never be served by a paid account.

## Verification status

What **is** proven, and how:

- Unit tests cover the registry and target resolution, answer parsing and
  request validation, endpoint/host resolution and headers, the decision proxy's
  accounting and failure handling, the catalog projection, the endpoint
  category/capability wiring, the route gates, and the dispatch loop
  (`tests/unit/systemone-*.test.ts`).
- Every test drives the real modules with **injected collaborators**: the
  upstream boundary (`fetchSystemOne`), the credential selector, the usage/cost
  writers and the cooldown writer are all fakes. No test opens a socket.

What is **not** proven:

- **No live call.** Request/response shapes, status codes, rate-limit headers,
  reported `usage` fields and the catalog shapes are all assumed from
  documentation. The first real call may disagree; that is what
  `contractVerified: false` records.
- **No containerized or staged run.** Docker is unavailable in this
  environment, so there is no recorded end-to-end run against a stub or a
  sandbox either.
- **No credentials.** The work used no provider keys, no live gateway account
  and no production data.

Production behavior is unchanged by this integration: the routes are additive,
chat paths are untouched apart from refusing decision-only models (which were
never dispatchable), and no existing default was flipped. Nothing enables a
backend that has no connection configured.

**Before trusting this path in production**, verify against one backend at a
time and record the result: a `noul`, `choice` and `score` request each; a `401`
with a deliberately bad key; a `429` and whether `Retry-After` is present; the
catalog read; and whether `usage.cost` is actually reported. Flip
`contractVerified` only for the backend that was verified, and only from the
evidence of that run.
