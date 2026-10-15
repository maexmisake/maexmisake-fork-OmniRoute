---
title: System One (native typed decisions) — contracts and verification status
description: Native System One contracts, account and cost policies, live smoke evidence, and remaining verification limits.
---

# System One (native typed decisions)

System One evaluates a supplied `state` with typed `noul` (yes/no), `choice`
(one option), and `score` (a rubric level) questions. Answers contain values and
probabilities rather than chat text. Native decisions use their own routes and
provider credentials; the older TypeSafe Jev combo strategy is separate.

**Verification date: October 14, 2026.** All three backends passed authenticated
catalog and three-operation smoke checks from the isolated Windows development
checkout. Eight Zen credentials each passed one free-model `noul` request. This
is a bounded smoke result, not a sustained-quota or all-model guarantee. No
production service, configuration, database, or Hindsight integration was changed.

## Surface and configuration

| Surface                               | Implementation                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `POST /v1/systemone`                  | `src/app/api/v1/systemone/route.ts` → `dispatch.ts` → `open-sse/handlers/systemOne.ts` |
| `GET /v1/systemone/models`            | `src/app/api/v1/systemone/models/route.ts` → `open-sse/handlers/systemOneModels.ts`    |
| Backend, target and tier rules        | `open-sse/config/systemOneRegistry.ts`                                                 |
| Transport and URL guards              | `open-sse/handlers/systemOneTransport.ts`                                              |
| Request validation and answer parsing | `open-sse/services/typesafe/systemOneAnswers.ts`                                       |
| Key permissions                       | `systemone` category in `src/shared/constants/endpointCategories.ts`                   |

The equivalent Next.js paths are `/api/v1/systemone` and
`/api/v1/systemone/models`. Restricted API keys need the `systemone` endpoint
category. Their model rules and connection allowlists still apply.

Use ordinary provider connections for `opencode-zen`, `vercel-ai-gateway`, or
`openrouter`. Multiple connections use the existing selector, health, cooldown,
and quota mechanisms. A free model requires a keyed connection explicitly tagged
`providerSpecificData.systemOneTier: "free"`; a paid target excludes that tag.
The tag controls routing eligibility and never removes authentication.

| Backend                | Decision endpoint                                    | Catalog endpoint                                                  |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| OpenCode Zen / Console | `https://opencode.ai/inference/v1/systemone`         | `https://opencode.ai/inference/v1/models`                         |
| Vercel AI Gateway      | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `https://ai-gateway.vercel.sh/typesafe/v1/models`                 |
| OpenRouter             | `https://openrouter.ai/api/v1/systemone`             | `https://openrouter.ai/api/v1/models?output_modalities=decisions` |

Each endpoint can be overridden independently in a connection's
`providerSpecificData.systemOneUrl` or `systemOneModelsUrl`. Overrides require
HTTPS, no embedded credentials, and a provider-owned allowlisted host. Normal
outbound/proxy guards apply, and redirects are refused.

## Request and response contracts

```json
{
  "model": "jev",
  "state": "A customer reports a failed payment and asks for urgent help.",
  "questions": {
    "urgent": { "type": "noul", "instructions": "Is this urgent?" },
    "route": {
      "type": "choice",
      "instructions": "Choose the responsible team.",
      "criteria": { "billing": "Payments and invoices", "tech": "Software faults" }
    },
    "severity": {
      "type": "score",
      "instructions": "Rate the severity.",
      "criteria": ["low", "medium", "high"]
    }
  }
}
```

`state` and `instructions` accept text, objects, or arrays, with finite JSON
values and at most 64 nested object/array levels. Choice has 1–255 named options;
its descriptions can be text, structured JSON, or null. Score has 2–10 ordered
text/structured levels and returns a possibly fractional zero-based score.
Noul takes instructions or at least one non-null description under its optional
`true` / `false` criteria map.

The current [HTTP reference](https://docs.typesafe.ai/api) describes instructions
as required, while the [JavaScript question interfaces](https://docs.typesafe.ai/sdk/javascript/api/interfaces/NoulQuestion)
permit omission/null for Choice and Score, and for Noul with described outcomes.
Validation accepts those SDK-compatible forms. Live smoke requests used explicit
text instructions; optional and structured forms are covered by local tests.

OmniRoute adds a 64-question / 1 MiB request guard. These are local safeguards;
TypeSafe does not document a separate 64-question model limit. Actual context
and model limits remain the upstream's responsibility. State is never truncated
or rewritten.

The success body is returned unchanged, retaining confidence, distributions,
Score legend, usage, and provider metadata. Before success/accounting, parsing
checks requested answer IDs and types, probability bounds, selected Choice
membership, and Score rubric range. Missing or mismatched answers return `502`
with `upstream_protocol_error`; they do not trigger account retries.

Upstream error prose is dropped because it can echo state or credentials. Only
HTTP status and identifiers from the existing bounded public error vocabulary
are returned or logged. Caller cancellation does not mark an account unhealthy.

## Discovery and chat compatibility

- Zen's OpenAI-style `data` list has Jev IDs without capability metadata. The
  provider-specific native registry identifies those documented decision IDs.
- Vercel's actual native response is `{ "models": [...] }`, with `name`,
  `description`, and `release_date`. It listed eight native models during this
  check, including bare `jev`; names are retained verbatim.
- OpenRouter's decision-filtered `data` list declares
  `architecture.output_modalities: ["decisions"]`. The upstream alias
  `~typesafe/jev-latest` keeps its leading tilde.

The native catalog lists only models allowed by the caller's model/connection
scope and an eligible connection's tier, exclusions, cooldown, and model lockout.
It is read-only and uncached, with at most three catalog account attempts per
backend. A failed backend does not hide healthy backends.

Decision capability survives ordinary discovery and managed-model sync/import.
Decision-only models are excluded from the unified chat catalog, custom chat
imports, and managed chat aliases; direct chat requests are rejected. Explicit
mixed chat/decision capability remains usable for chat.

Catalog membership is not proof that every discovered model family accepts
identical operations or context sizes. The live operation matrix below covers
Jev only; other model families remain untested.

## Routing, fallback and accounting

A provider-qualified ID such as `openrouter/typesafe/jev-1.13` pins one backend.
Bare `jev` / `jev-1.13` aliases try configured paid backends in registry order:
Zen, OpenRouter, then Vercel. This is a fixed order, not dynamic price selection.
`jev-free` / `jev-1.13-free` resolve only to Zen's exact free model; they cannot
fall back to a paid model or paid-tagged account.

Connections are filtered for tier before selection. The loop spends at most
three connections per candidate and at most three provider candidates. Key model
rules and resolved provider/model token limits are checked before credentials
are selected. Account faults (`401`, `402`, `403`, `429`) and availability faults
(`408`, eligible `5xx`) can rotate accounts. Classified gateway/transport `502`
errors can retry; malformed successful payloads and caller-shape faults cannot.
A provider-qualified request never crosses providers.

Each upstream attempt produces a call log; each successful decision produces a
usage row and advances token and TPM/RPM counters. Policy, response metadata, and
call logs use the canonical provider-qualified ID. Usage pricing and model
cooldowns use the upstream ID expected by their existing readers.

Cost precedence is:

1. A numeric upstream `usage.cost`, including known zero.
2. Vercel's decimal `provider_metadata.gateway.cost`.
3. Operator pricing / the existing pricing resolver.
4. The explicitly published zero input/output rate for Zen's exact
   `jev-1.13-free` model, confirmed in [OpenCode's pricing table](https://opencode.ai/v2/docs/console/models/#pricing).
5. Unknown, with `X-OmniRoute-Cost-Status: unknown` and no cost header.

Vercel and OpenRouter reported exact paid costs in live tests. Zen omitted cost;
its documented free-rate fallback is covered by a real-writer regression. No
other model is silently priced as free. Reported/operator prices take precedence
if the limited-time free offering changes.

Migration `206_usage_history_cost_usd.sql` adds nullable `usage_history.cost_usd`.
Known costs, including zero, persist there so daily/weekly USD quotas use the same
amount that the response reports. Historical/unknown-cost rows keep token-based
pricing and fail closed under USD quotas if unpriced. Token and request limits
are independent of USD limits. Tests applied this migration only to disposable
databases; production migration/rollout remains separate work.

## Verification evidence

| Check                                                                         | Actual result                                                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Zen credentials 1–8, one `jev-1.13-free` Noul each                            | Eight HTTP 200 responses, valid probabilities; no retries                                                                                        |
| Zen native dispatch/proxy with free Jev, all three operations                 | HTTP 200; catalog 200; raw usage 364 input / 61 output tokens                                                                                    |
| Vercel direct `typesafe-ai/jev` and native proxy with advertised `jev`        | Both three-operation requests returned 200; authenticated native catalog 200                                                                     |
| OpenRouter direct `typesafe/jev-1.13` and native proxy `~typesafe/jev-latest` | Both three-operation requests returned 200; alias resolved to `typesafe/jev-1.14-20261014`; catalog 200                                          |
| Paid request budget                                                           | Four tiny requests total; each reported USD 0.000015288, total USD 0.000061152                                                                   |
| Failure scenarios                                                             | Mocked upstreams and isolated real accounting/auth/selection databases; no deliberately induced live 401/429 or quota exhaustion                 |
| Focused source verification                                                   | Native, quota, discovery, import, policy, and accounting regressions; exact final commands/results recorded in the PR                            |
| Vitest                                                                        | 56 files, 500 tests passed                                                                                                                       |
| Broad Windows unit attempt                                                    | Stopped after 22 failures in OS/CLI/other unrelated suites; full unit suite is not green or fully verified                                       |
| Production Docker                                                             | Final resource-capped build and container smoke result recorded in the PR; a 4 GiB heap attempt exhausted its own heap without a host/kernel OOM |

Credential values never appeared in output, source, commits, or saved evidence.
Live transport and parsing used real provider requests; credential selection in
that live harness was supplied in memory. Separate isolated-database tests prove
the real shared selector, account filters, quota counters, and policy gates.
The container smoke uses synthetic gateway authentication and no provider keys.

Not established by this work: sustained/concurrent Zen allowance, shared-IP
limits, paid Zen inference, real upstream throttling/reset headers, every
provider/model/optional-input combination, or staging/production readiness.
Nothing was deployed, merged, or changed in production.
