---
title: "Bounded Native Router Tool Continuation"
version: 3.8.52
lastUpdated: 2026-10-26
---

# Bounded native-router tool continuation

This is an isolated, opt-in application contract reviewed with offline fixtures. It does not establish live
free-Zen access, subscription entitlement, a complete installed Hermes agent or model-selection
quality. Ordinary routing defaults and the historical 23-choice pool remain unchanged.

## Request and selection

The twelve original Claude model/effort choices support this tool contract. The thirteenth admitted text choice, AGY Gemini High, is text SSE only and cannot enter tools or continuation. The tool path uses the existing `bounded-v1` application path, Chat Completions text SSE,
an explicit output cap and an explicitly configured Claude model/effort profile with tools enabled.
Tool selection supports `auto` and `none`, with bounded declared function schemas and optional
`parallel_tool_calls`. Other tool controls, images, nonstreaming tools and unproven execution
transports reject safely. The separate OpenAI text lane is not silently enabled for tools.

An initial request offers only currently eligible exact model/effort pairs to the configured native
selector. Multiple choices need one decision; a sole eligible choice needs none. Free Zen requires
explicit `jev-1.13-free` configuration and its actual free-tier guard. No error enables a paid
selector, another account, a chat substitute or a hidden execution fallback.

A valid tool-result continuation does not call the selector again. It retains the completed
origin's exact provider, account, model and effort, rechecks current eligibility and authority, and
receives its own admission, RPM consumption, reservation and physical receipt. Client-supplied
tool IDs only locate a proof; they grant neither permission to run a tool nor evidence that one ran.
The pinned pair must also remain listed in the explicit continuation task policy. A missing, empty
or excluding continuation list means no route; reordering that list cannot switch the pinned pair.

## Completion and continuation authority

The raw provider stream and the translated client tool group must agree before authority is issued.
The gateway waits for genuine raw terminal plus EOF and a complete client group. It withholds final
completion/usage/DONE frames until the existing journal can atomically commit application success
and continuation metadata. A caller can immediately submit results after DONE. Partial output,
refusal, malformed groups, cancellation before publication, failed metadata publication or uncertain
execution cannot create a usable handoff or trigger another attempt. Physical usage already observed remains
recorded even when client completion fails; missing cost remains unknown.

The durable commit precedes network delivery; it is not a client delivery acknowledgement. Late
disconnects do not roll a committed handoff back into a retryable execution. Every later explicit
continuation still needs fresh authentication, admission and the original bounded proof.

Metadata binds the accepted original client prefix, tool contract, call descriptors, original
identity and current policy. Legitimate tool IDs may repeat in later groups; proof and signed replay
remain occurrence-bound. Reversed results are compared by exact ID/content within their group,
rather than by an unsafe global ID map. Changed prefixes, schemas, accounts or effort reject.

The two namespaced metadata tables contain fingerprints and bounded locators, not messages, tool
arguments/results or signed thinking payloads. Fingerprints do not claim secrecy after trusted
database compromise. Signed replay uses the existing memory cache under private source-attempt
locators and is checked against origin/account-bound proof. Losing required replay after restart
rejects before dispatch; no placeholder signature or recovery account is substituted.

Bounds are 32 calls per group, 32 live groups per key/combo, 32 ancestry depth, a 30-minute authority
window anchored to the origin and 256 KiB of canonical proof input. Conservative leaf cleanup
preserves ancestry while descendants could still publish. This does not promise exactly-once remote
execution, timed secure erasure or indefinite continuation after a slow/disconnected client.

## Deliberate support limits

This first slice requires a complete signed-thinking tool group before issuing continuation
authority. A tool group without required signed replay is unsupported, rather than supplied with an
invented signature. The supported native ordering is signed-thinking blocks, then text, then tool
calls. Backwards transitions reject instead of silently changing ordering. Integer tool arguments
outside JavaScript's safe range reject rather than changing their meaning for a Python client.

Pinned Hermes source constructors and request builders execute with explicit synthetic collaborators. A later actual OpenAI SDK 2.54.0/HTTPX 0.28.1 fixture on standalone Python 3.12 independently passes **15/15**, including SDK tool-call assembly, original result constructors and a second SDK request through the actual handler with the same account/model/effort and no second decision. Synthetic results are supplied; no tool runs. It does not execute the complete installed Hermes agent, whose pinned runtime requires Python 3.14.

The ordinary Hermes custom path turns unset effort into explicit Medium; that remains a hard constraint. The new optional [effort-delegation extension](HERMES_EFFORT_DELEGATION.md), independently checked **22/22**, preserves explicit effort/Off and ordinary defaults while allowing intentional unset-default omission for one approved relay/combo. Its dedicated profile and two pinned guards are mandatory and remain uninstalled. SDK fixtures demonstrate omitted effort stays absent across both tool requests; the trusted continuation still pins the original selected pair. Off is not delegation and rejects when that pair cannot honor it.

The nine Codex OAuth choices and AGY Opus High remain excluded for the precise [execution-contract gaps](NATIVE_ROUTER_CAPABILITIES.md). Gemini High has a guarded text-only SSE contract, not tool support. Automatic OAuth refresh, broader optional-feature coexistence, compatible production build/browser checks and live free-Zen validation remain separate work. No real prompt excerpt was newly sent to a decision provider, no security setting was weakened and no live configuration changed.

## Offline acceptance and limits

At the preceding October 26 tool-continuation checkpoint, all twelve admitted Claude model/effort pairs have synthetic tool round trips through the actual
handler, including the two Max-effort exception boundaries. The pinned Hermes High constructor is
kept distinct from synthetic requests with adjusted efforts. That checkpoint
passed fourteen independent adversarial cases and 1,154 selected checks across sixty files. Those historical counts do not include the later SDK/effort-extension or AGY additions.
The whole repository suite is unrun.

Core compilation and scoped lint pass. Strict core retains eighteen diagnostics byte-identical to
the actual stable baseline; complexity remains within unchanged limits. The first broad run found
one stale connection-read inventory count, which was independently classified, corrected and
retested before the full selected rerun passed. Deferred timeout/call-log teardown warnings remain
in raw evidence. These checks establish neither production readiness nor full Hermes compatibility.
