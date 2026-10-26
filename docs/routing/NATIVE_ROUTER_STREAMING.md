---
title: "Bounded Native Router Text Streaming"
version: 3.8.52
lastUpdated: 2026-10-26
---

# Bounded native-router text streaming

Evidence date: October 26, 2026. This describes local application-handler tests with synthetic
providers. No real provider, account entitlement, installed Hermes client or routing-quality result
is established. Ordinary routing defaults remain unchanged.

## Request and transport

An explicitly enabled `bounded-v1` combo accepts text requests with `stream:true`, an explicit
`max_tokens`/`max_completion_tokens` cap and an allowed model/effort profile. Optional
`stream_options.include_usage` is preserved for the OpenAI execution contract. Unsupported options,
conflicting effort/cap carriers, tools, images and continuations reject before execution. A free
Zen selector still requires explicit `jev-1.13-free` configuration and the stored free-tier guard.
Neither streaming nor a quota error enables paid fallback.

Selection and execution use the existing application path. With multiple eligible choices, the
native selector makes one non-streaming Choice request, then one guarded execution. A sole eligible
choice makes no decision request. The Claude execution body keeps exact adaptive thinking,
`output_config.effort`, model, OAuth account and output cap. Its ordinary response translator
produces the client-facing Chat Completions stream. No parallel gateway was added.

## Completion and accounting

The raw provider tap validates bounded UTF-8/SSE framing, exact model, permitted text/thinking
events and genuine provider completion. It does not trust a translator's synthesized terminal
marker as provider evidence. Input/cache counts already reported can be retained on interruption;
final output and cost remain unknown until completion. Unknown cost is never zero. Fixture costs
exercise accounting and are not vendor prices.

The returned cost-status header stays `pending`; already-sent headers are not updated at completion. The journal carries the final receipt. Decision and execution journal rows
remain separate; final usage/cost belongs to the physical execution once. Cancellation, truncated
or invalid streams retain their failure/unknown outcome. A client that closes after receiving a
verified final terminal marker is distinguished from an interrupted client.

Two demand-driven taps preserve backpressure through the existing pipeline. Only the opt-in lane
uses the smaller disconnect queue. It disables ordinary readiness/sibling, empty-turn and midstream
recovery retries and captures its trusted context for delayed callbacks. Ordinary ancillary
usage-sync and accounting callbacks do not run again outside that context. Cancellation directly
reaches the raw reader; cleanup does not await an uncooperative provider cancellation promise.

The existing combined decision/execution deadline is at most 30 seconds; local stage leases expire
after 45 seconds. This slice adds no renewal, automatic OAuth refresh or claim that a remote call
definitely stopped when local occupancy is released. Missing remote bills remain unknown. A slow
consumer does not gain an unbounded lease or another execution.

## Offline checks and proof limits

The actual-handler fixtures are
[streaming acceptance](../../tests/integration/decision-application-stream.test.ts) and
[independent adversarial cases](../../tests/integration/decision-application-stream-adversarial.test.ts).
They use closed in-memory fetch interceptors plus the existing offline guard, temporary databases
and synthetic keys. They cover first content before terminal, slow consumption, split UTF-8/CRLF,
exact usage, missing usage, refusal, malformed/truncated streams, cancellation and no extra dispatch.
Final run counts and hashes are recorded in private Gravewire; overlapping reviewer runs are not
added together as independent coverage.

The [pinned Hermes fixture](../../tests/fixtures/decisionPolicy/hermesPinned/README.md) executes
selected original source builders and declares its JSON projection/stream-driver substitutions.
It is not a full SDK or agent run. OpenAI Python SDK execution is still unrun in this executor;
official hash-locked package fetching stopped at DNS failure before installing a package. The production build remains blocked by the previously recorded SWC environment restriction;
visual browser checks were not performed. No security setting, dependency version, real account or live
configuration was changed for these tests.
