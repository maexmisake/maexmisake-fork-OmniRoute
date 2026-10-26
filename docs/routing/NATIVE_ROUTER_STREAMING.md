---
title: "Bounded Native Router Text Streaming"
version: 3.8.52
lastUpdated: 2026-10-26
---

# Bounded native-router text streaming

Evidence date: October 26, 2026. This describes local application-handler tests with synthetic
providers. No real provider, account entitlement, installed Hermes client or routing-quality result
is established. Ordinary routing defaults remain unchanged.

## Current ID-less correlation follow-up

The source implementation supports a native functionCall whose `id` is genuinely absent. A gateway client `gmc_` ID is issued by call ordinal under a private v2 namespace derived from the original execution attempt. The HMAC-authenticated origin and original Parts remain authority; the client ID and namespace shape alone are not. Each active historical group uses its own namespace, including three-request chains. Native replay preserves ID absence, and functionResponse omits its ID when the original call had none. Explicit native IDs remain exact; null/empty IDs and collisions reject. Explicit-ID-only v1 replay and its existing HMAC checks remain valid.

The earlier installed-SDK run passed **20/20** before final metadata-relation hardening; the handler's **40-case run** and focused three-request active-chain check passed. The final source-stable selected Node regression passed **1,751/1,751 across 81 files**, including all 41 handler and 20 installed-SDK cases, with zero skips/cancellations and unchanged source/test hashes. Separate current Vitest passed **590/590**. Focused independent review of nine handler and two SDK cases also passed. Core compilation passed; strict core retained the same 18 byte-identical release-baseline diagnostics. These are selected offline checks, not full-repository, production-build, live-service or quality acceptance. The two original pinned Hermes ID helpers now execute in the SDK fixture instead of legacy ID-prefix facades; legacy fixture defaults are unchanged. This proves neither full Hermes Python3.14/runtime nor real tool execution, live signature validity or quality. It does not enable Codex execution.

## Request and transport

An explicitly enabled `bounded-v1` combo accepts text requests with `stream:true`, an explicit
`max_tokens`/`max_completion_tokens` cap and an allowed model/effort profile. Optional
`stream_options.include_usage` is preserved for the OpenAI execution contract. Unsupported options,
conflicting effort/cap carriers and images reject before execution. The separately scoped
[tool continuation contract](NATIVE_ROUTER_TOOLS.md) requires explicit tool-capable profiles. Its current [Gemini subset](NATIVE_ROUTER_GEMINI_TOOLS.md) is restricted to complete native calls and active-cycle replay; other unproven tool transports reject. A free
Zen selector still requires explicit `jev-1.13-free` configuration and the stored free-tier guard.
Neither streaming nor a quota error enables paid fallback.

Selection and execution use the existing application path. With multiple eligible choices, the
native selector makes one non-streaming Choice request, then one guarded execution. A sole eligible
choice makes no decision request. Thirteen original text choices are admitted: twelve Claude pairs and `agy/gemini-3.8-flash-high` at High. All thirteen now have an implemented opt-in tool contract: twelve Claude pairs plus the narrower Gemini complete-call subset. At the preserved October 26 `e3a3d6fe` checkpoint, the focused handler run passed **32/32** and the installed-SDK run passed **18/18**, including three new AGY cases and original-schema assertions. That checkpoint's selected regression passed **1,658/1,658 across 79 files**, and focused independent application/SDK acceptance passed. The whole repository suite remains unrun. Gemini remains SSE only. The separate explicit OpenAI API-key text lane is not an original-pool substitute. The Claude execution body keeps exact adaptive thinking,
`output_config.effort`, model, OAuth account and output cap. Its ordinary response translator
produces the client-facing Chat Completions stream. The exact AGY lane uses its existing Cloud Code formatter with a ready OAuth/project binding, exact High, an unchanged output cap and truthful application identification. Unsupported credentials, compatibility fingerprints or late wire changes reject before dispatch. No parallel gateway was added.

## Completion and accounting

The raw provider tap validates bounded UTF-8/SSE framing, exact model, permitted text/thinking
events and genuine provider completion. It does not trust a translator's synthesized terminal
marker as provider evidence. Input/cache counts already reported can be retained on interruption;
final output and cost remain unknown until completion. AGY reports visible candidate output and thoughts separately; absent thought usage is not inferred from a total. Its response contract supplies no exact USD receipt, so even a successful AGY execution keeps cost unknown. Unknown cost is never zero. Fixture costs
exercise accounting and are not vendor prices.

For the Gemini tool subset, a valid completed no-call refusal retains HTTP200 stream delivery with `content_filter` and application422 in the journal. It is a model refusal, not a successful tool handoff or transport failure. A refusal with current/prior native calls cannot create authority. No error or refusal triggers another provider attempt.

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

The earlier [pinned Hermes source fixture](../../tests/fixtures/decisionPolicy/hermesPinned/README.md) uses declared projection/stream-driver substitutions. The later [installed SDK fixture](../../tests/integration/decision-hermes-installed-sdk.test.ts) independently passed **15/15** at the preceding checkpoint, using actual OpenAI SDK 2.54.0/HTTPX 0.28.1 on standalone Python 3.12 and a bounded in-memory bridge into the real handler. It covers SDK JSON/SSE parsing, tool assembly/continuation, terminal denial, cancellation, honest costs and effort-profile cases. At the preserved October 26 `e3a3d6fe` checkpoint, the installed-SDK run passed **18/18** (the earlier fifteen plus three AGY cases), with strengthened original-schema assertions and natural exit 0. That checkpoint's selected 79-file regression and focused independent acceptance passed. This is not a TCP/TLS server test or full installed Hermes runtime; the pinned full agent requires Python 3.14. The optional [effort-delegation extension](HERMES_EFFORT_DELEGATION.md) has separate **22/22** source-builder checks and remains uninstalled.

The earlier SDK attempt stopped before installation at DNS failure. A subsequent ordinary hash-locked installation succeeded using the environment's existing standard proxy configuration, without changing trust/security settings or package versions. That supersedes the old unrun status; it does not resolve the separate production build's SWC ownership restriction. A compatible production build and visual browser checks remain unverified. No real account or live configuration changed for these tests.
