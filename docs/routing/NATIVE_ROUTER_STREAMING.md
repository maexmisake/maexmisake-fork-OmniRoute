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
conflicting effort/cap carriers and images reject before execution. The separately scoped
[Claude tool continuation contract](NATIVE_ROUTER_TOOLS.md) requires explicit tool-capable profiles;
other tool transports reject. A free
Zen selector still requires explicit `jev-1.13-free` configuration and the stored free-tier guard.
Neither streaming nor a quota error enables paid fallback.

Selection and execution use the existing application path. With multiple eligible choices, the
native selector makes one non-streaming Choice request, then one guarded execution. A sole eligible
choice makes no decision request. Thirteen original text choices are admitted: twelve Claude pairs and `agy/gemini-3.8-flash-high` at High. Only the twelve Claude choices support tools and continuation; Gemini is guarded text SSE only, with no tools or nonstreaming path. The separate explicit OpenAI API-key text lane is not an original-pool substitute. The Claude execution body keeps exact adaptive thinking,
`output_config.effort`, model, OAuth account and output cap. Its ordinary response translator
produces the client-facing Chat Completions stream. The exact AGY lane uses its existing Cloud Code formatter with a ready OAuth/project binding, exact High, an unchanged output cap and truthful application identification. Unsupported credentials, compatibility fingerprints or late wire changes reject before dispatch. No parallel gateway was added.

## Completion and accounting

The raw provider tap validates bounded UTF-8/SSE framing, exact model, permitted text/thinking
events and genuine provider completion. It does not trust a translator's synthesized terminal
marker as provider evidence. Input/cache counts already reported can be retained on interruption;
final output and cost remain unknown until completion. AGY reports visible candidate output and thoughts separately; absent thought usage is not inferred from a total. Its response contract supplies no exact USD receipt, so even a successful AGY execution keeps cost unknown. Unknown cost is never zero. Fixture costs
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

The earlier [pinned Hermes source fixture](../../tests/fixtures/decisionPolicy/hermesPinned/README.md) uses declared projection/stream-driver substitutions. The later [installed SDK fixture](../../tests/integration/decision-hermes-installed-sdk.test.ts) independently passes **15/15**, using actual OpenAI SDK 2.54.0/HTTPX 0.28.1 on standalone Python 3.12 and a bounded in-memory bridge into the real handler. It covers SDK JSON/SSE parsing, tool assembly/continuation, terminal denial, cancellation, honest costs and effort-profile cases. This is not a TCP/TLS server test or full installed Hermes runtime; the pinned full agent requires Python 3.14. The optional [effort-delegation extension](HERMES_EFFORT_DELEGATION.md) has separate **22/22** source-builder checks and remains uninstalled.

The earlier SDK attempt stopped before installation at DNS failure. A subsequent ordinary hash-locked installation succeeded using the environment's existing standard proxy configuration, without changing trust/security settings or package versions. That supersedes the old unrun status; it does not resolve the separate production build's SWC ownership restriction. A compatible production build and visual browser checks remain unverified. No real account or live configuration changed for these tests.
