---
title: "Opt-in Gemini High Tool Continuation"
version: 3.8.52
lastUpdated: 2026-10-26
---

# Opt-in Gemini High tools

The local router implements tool continuation for **13 original choices**: twelve Claude pairs and exact `agy/gemini-3.8-flash-high` at High. The current Gemini follow-up supports calls with an absent native ID through authenticated client-only correlation. It remains opt-in, with unchanged defaults and no live account or routing-quality proof. The final source-stable selected Node regression passed **1,751/1,751 across 81 files**, including all 41 handler and 20 installed-SDK cases, with zero skips/cancellations and unchanged source/test hashes. Separate current Vitest passed **590/590**. Focused independent review of nine handler and two SDK cases also passed. Core compilation passed; strict core retained the same 18 byte-identical release-baseline diagnostics. These are selected offline checks, not full-repository, production-build, live-service or quality acceptance.

## What the Gemini path does

- Selects only an eligible explicit profile. Two or more choices can use one native Jev decision; a sole choice needs no decision. No candidate or quality rank is invented.
- Keeps the selected AGY OAuth account, exact model, High effort and project. Each execution keeps its freshly reserved output cap unchanged.
- Returns complete declared function calls with their original native IDs or client-only `gmc_` correlation IDs when the native ID was absent. A matching result continues on that original pair without another decision; the router does not run the function itself.
- Rechecks authentication, current policy, continuation-list membership and connection authority before another send. Tool IDs locate proof; they do not grant permissions.
- Replays original native Parts in their original order and model Content boundary. Signatures stay on their original Parts. Results use original call order and names. A native result ID is echoed only when the original native call had one; otherwise it stays absent. Result strings remain strings.

Each active group has its own private v2 namespace derived from the original execution attempt and bound by origin/HMAC proof. The client ID is a locator, not authority, and never becomes an invented native call/result ID. Explicit-ID-only v1 replay remains valid. Null/empty IDs, collisions and forged or unused namespaces reject; no ID is guessed from a client payload.

The initial selector may choose another explicitly eligible model. Once an AGY execution is attempted, failure does not enable another account, model, paid provider, retry or hidden fallback.

## What remains restricted

Only the **active last-user cycle** is supported. Older completed tool cycles before a newer user are excluded before the decision call, even when a new active cycle follows. Public current-turn signature guidance does not establish a private AGY older-history waiver. Active authenticated multistep groups remain bound to their own source occurrences.

Replay Parts live in a bounded, private process-local store. Restart, eviction or missing replay causes rejection. Durable metadata cannot recreate signatures. This path does not sign, graft signatures, insert a sentinel or use the ordinary global tool-ID signature cache. Nonempty opaque signature bytes are not cryptographic validity proof.

Unsupported: fragmented `partialArgs`/`willContinue`, either OpenAI strict flag, `parallel_tool_calls:false`, named/required tool choice, media, nonstreaming execution and positive `toolUsePromptTokenCount`. Tool choice supports `auto` and `none`. JSON Schema is preserved in native `parametersJsonSchema`; it is not silently rewritten to another schema dialect. A listing or configured credential does not establish entitlement.

## Outcomes and evidence

The preserved October 26 `e3a3d6fe` checkpoint passed 1,658 selected checks across 79 files, 590 separate Vitest cases, 18 SDK and 32 handler cases. Those dated results are separate from the current source-stable correlation acceptance above. The SDK fixture now executes two original pinned Hermes ID helpers instead of its old prefix facades; legacy defaults are unchanged. No real tool runs, and this helper work does not enable Codex execution.

A completed no-call refusal can arrive over HTTP200 SSE with client `content_filter`; the journal records application422 and no continuation authority. This is distinct from a transport failure. Refused, incomplete, cancelled or malformed tool output cannot authorize a follow-on send. Missing usage or USD cost remains unknown, not zero; decision and execution receipts are separate.

Current source: [application strategy](../../src/lib/decisionPolicy/applicationGeminiTools.ts), [exact wire contract](../../src/lib/decisionPolicy/geminiToolWire.ts), [raw proof](../../src/lib/decisionPolicy/geminiToolResponseProof.ts), [process-local replay](../../src/lib/decisionPolicy/geminiToolReplay.ts) and [synthetic handler fixtures](../../tests/integration/decision-agy-tools-contract.test.ts). Source-backed behavior and fixture success do not prove live protocol compatibility, full installed Hermes Python3.14 operation or better model selection.

The preceding checkpoint's selected regression and focused independent acceptance are complete. The source-stable correlation checks above are complete; a separately authorized, bounded live compatibility check remains. No live provider call or configuration change is part of this documentation update.
