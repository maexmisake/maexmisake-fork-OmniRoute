---
title: "Bounded Native Router Capabilities"
version: 3.8.52
lastUpdated: 2026-10-26
---

# Bounded native-router capabilities

Evidence date: October 26, 2026. Admitted means the runtime allows the explicitly configured contract. All twelve Claude pairs have exact JSON and signed tool-SSE application-handler round trips with synthetic providers. Plain-text SSE tests cover representative pairs and an explicit OpenAI fixture, not the complete cross-product of every request option. This does not prove account access, live OAuth interoperability, billed cost or model-selection quality. Saving a profile never runs a provider request.

## Execution contracts

| Provider | Canonical model                  | Admitted efforts                                        | Authentication and output                                                                                   |
| -------- | -------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `claude` | `claude-opus-5-5`                | medium, high, xhigh, max                                | Existing pinned, ready OAuth connection; adaptive thinking; explicit unchanged output cap; JSON or text SSE |
| `claude` | `claude-sonnet-5-5`              | medium, high, xhigh, max                                | Same guarded OAuth contract; exact effort and model                                                         |
| `claude` | `claude-haiku-5-5`               | medium, high, xhigh, max                                | Same guarded OAuth contract; exact effort and model                                                         |
| `openai` | Explicit operator-supplied model | Only the profile's explicitly declared supported effort | Existing API-key lane; exact identity and bounded JSON/text SSE contract; no inferred catalog availability  |

The twelve Claude pairs are explicitly scoped. The Claude lane does not admit other models or low effort. Exact trusted application context preserves documented Sonnet/Haiku max through two legacy clamps; final dispatch still requires the selected literal effort. Ordinary requests retain their existing clamps and effort lists. No global model registry or ordinary effort defaults were changed.

Primary public contracts: [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview), [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview), [effort and output accounting](https://platform.claude.com/docs/en/build-with-claude/effort), and the separate [Claude Code model configuration](https://code.claude.com/docs/en/model-config). These mutable documents were checked on the evidence date. API-key authentication and subscription OAuth are distinct; documentation does not establish a particular account's entitlement or third-party OAuth compatibility.

The bounded Claude lane sends no sampling controls. Its trusted request scope prevents the legacy formatter from synthesizing temperature 1; it does not delete supplied sampling fields. Explicit or late-injected temperature/top_p/top_k remain visible and are rejected at the final fence. Ordinary requests retain their prior sampling normalization. No client-visible bypass flag was introduced.

Capabilities, context limits, effort support and evidence remain explicit operator profile declarations. A listing, active connection or declaration is not a successful provider test. Unsupported or unknown contracts must not be silently substituted with another model, effort, account or paid provider. Codex OAuth/Responses and Antigravity execution remain unimplemented in this bounded lane; the OpenAI API-key lane is not a substitute for them.

## Native selection

The selector receives only currently eligible explicit model-and-effort options. A client-supplied effort is a hard constraint. For example, explicit Medium can offer both Opus Medium and Sonnet Medium; it does not authorize High or Max. Operator task preferences remain unchanged. Confidence is a provider-reported value, not measured correctness or permission.

Two or more eligible options use the configured native decision provider; exactly one uses the existing guarded execution with explicit `sole-eligible` / `no-decision`; zero returns `no-route`. Decision and execution receipts remain separate. Refusal, malformed selection, authentication/access/quota denial, cancellation and queued policy changes cannot authorize an unintended execution or hidden fallback.

Free Zen requires an explicit native `jev-1.13-free` binding and the actual free routing guard. These local fixtures establish no live free-Zen success or quota-reset scope. Existing paid selector contracts remain separate; no paid fallback is introduced.

## Pinned Hermes fixture boundary

The fixture uses original request-builder fragments from [Hermes commit 749cb638ff43f9ce5333c186a1e4f67d473aa4f2](https://github.com/NousResearch/hermes-agent/tree/749cb638ff43f9ce5333c186a1e4f67d473aa4f2), with its MIT license and byte-level provenance. Original assembly, effort and cap functions execute with named fixture collaborators; whole Hermes modules, configuration, dotenv, authentication and plugins are not imported.

An explicit fixture projection turns the captured SDK kwargs into JSON for the actual application handler. The Python OpenAI SDK is absent and was not installed. This proves request assembly plus the declared projection and application behavior, not SDK HTTP serialization, headers/retries, the full client driver or an installed Hermes version. Stream flags and sanitized-message collaborators supplied by the fixture are labeled as substitutions.

The custom profile's original default-Medium method executes in the fixture. Its Medium directive remains hard: a synthetic free Jev decision can choose matching Medium pairs and then one exact execution. A configured output cap is required. The source-derived stream/tool request and tool-result constructors now have an actual-handler positive continuation fixture. Omitted caps and unproven execution transports still reject. Stream-driver collaborators remain explicitly supplied; neither the full driver nor the installed SDK executes. The full Hermes agent is not yet compatible by default.

The overall decision-plus-execution deadline remains 30 seconds per request. Scoped Claude tool continuation is described in [its contract](NATIVE_ROUTER_TOOLS.md): the origin stays pinned, each continuation needs fresh admission and explicit continuation-policy membership, and signed replay loss rejects. Automatic OAuth refresh, broader execution contracts, optional-feature coexistence, recovery/evaluation UX and quality validation remain unfinished. No raw message excerpt was newly sent to a decision provider; live content-aware classification retains its separate privacy decision.

## Text streaming boundary

The same opt-in application handler now accepts text SSE with exact provider/model/effort and an explicit output cap. Raw provider frames are inspected before ordinary translation; a bounded pull-through wrapper preserves backpressure and independently observes client completion/cancellation. Provider terminal evidence and downstream synthesized completion are kept separate. Decision calls remain non-streaming. See [streaming behavior and tests](NATIVE_ROUTER_STREAMING.md).

The historical pool remains 23 choices. Twelve Claude pairs have synthetic JSON dispatch coverage; representative SSE coverage is separate. The nine source-documented Codex pairs are not admitted: the current subscription executor strips output-limit fields, leaving the hard output-reservation contract unresolved. The two `agy` pairs still lack verified exact wire/effort/cap contracts; `agy` and `antigravity` are not silently equated. No API-key model substitutes or changed historical rankings were introduced.

Hermes pins OpenAI Python SDK 2.54.0 for its Python>=3.14 environment. This executor has Python3.12; the SDK itself supports it, but an isolated exact hash-locked installation stopped at registry DNS failure before any package installed. SDK serialization/parsing remains unrun. No alternative network route, dependency upgrade or build-security bypass was attempted.
