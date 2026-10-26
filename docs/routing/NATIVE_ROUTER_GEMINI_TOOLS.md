---
title: "Opt-in Gemini High Tool Continuation"
version: 3.8.52
lastUpdated: 2026-10-26
---

# Opt-in Gemini High tools

The local router now implements tool continuation for **13 original choices**: twelve Claude pairs and exact `agy/gemini-3.8-flash-high` at High. Gemini supports a narrow complete-call SSE subset. It is opt-in, changes no ordinary default and has no live account or routing-quality proof. The focused handler run passed **32/32** and the current installed-SDK run passed **18/18** (earlier fifteen plus three AGY cases, including original-schema assertions), both with natural exit 0. The selected regression passed **1,658/1,658 across 79 files** and focused independent application/SDK acceptance passed; the earlier fifteen-case result remains a separate dated checkpoint. The whole repository suite remains unrun.

## What the Gemini path does

- Selects only an eligible explicit profile. Two or more choices can use one native Jev decision; a sole choice needs no decision. No candidate or quality rank is invented.
- Keeps the selected AGY OAuth account, exact model, High effort and project. Each execution keeps its freshly reserved output cap unchanged.
- Returns complete declared function calls with explicit native IDs. A matching result continues on that original pair without another decision; the router does not run the function itself.
- Rechecks authentication, current policy, continuation-list membership and connection authority before another send. Tool IDs locate proof; they do not grant permissions.
- Replays original native Parts in their original order and model Content boundary. Signatures stay on their original Parts. Results use the original call order and exact IDs/names; result strings remain strings.

The initial selector may choose another explicitly eligible model. Once an AGY execution is attempted, failure does not enable another account, model, paid provider, retry or hidden fallback.

## What remains restricted

Only the **active last-user cycle** is supported. Older completed tool cycles before a newer user are excluded before the decision call, even when a new active cycle follows. Public current-turn signature guidance does not establish a private AGY older-history waiver. Active authenticated multistep groups remain bound to their own source occurrences.

Replay Parts live in a bounded, private process-local store. Restart, eviction or missing replay causes rejection. Durable metadata cannot recreate signatures. This path does not sign, graft signatures, insert a sentinel or use the ordinary global tool-ID signature cache. Nonempty opaque signature bytes are not cryptographic validity proof.

Unsupported: fragmented `partialArgs`/`willContinue`, either OpenAI strict flag, `parallel_tool_calls:false`, named/required tool choice, media, nonstreaming execution and positive `toolUsePromptTokenCount`. Tool choice supports `auto` and `none`. JSON Schema is preserved in native `parametersJsonSchema`; it is not silently rewritten to another schema dialect. A listing or configured credential does not establish entitlement.

## Outcomes and evidence

A completed no-call refusal can arrive over HTTP200 SSE with client `content_filter`; the journal records application422 and no continuation authority. This is distinct from a transport failure. Refused, incomplete, cancelled or malformed tool output cannot authorize a follow-on send. Missing usage or USD cost remains unknown, not zero; decision and execution receipts are separate.

Current source: [application strategy](../../src/lib/decisionPolicy/applicationGeminiTools.ts), [exact wire contract](../../src/lib/decisionPolicy/geminiToolWire.ts), [raw proof](../../src/lib/decisionPolicy/geminiToolResponseProof.ts), [process-local replay](../../src/lib/decisionPolicy/geminiToolReplay.ts) and [synthetic handler fixtures](../../tests/integration/decision-agy-tools-contract.test.ts). Source-backed behavior and fixture success do not prove live protocol compatibility, full installed Hermes Python3.14 operation or better model selection.

The source-matched selected regression and focused independent acceptance are complete. A separately authorized, bounded live compatibility check remains. No live provider call or configuration change is part of this documentation update.
