# Bounded native-router capabilities

Evidence date: October 26, 2026. Support here means an exact request contract exercised through the application handler with synthetic providers. It does not prove account access, live OAuth interoperability, billed cost or model-selection quality. Saving a profile never runs a provider request.

## Execution contracts

| Provider | Canonical model                  | Admitted efforts                                        | Authentication and output                                                                                     |
| -------- | -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `claude` | `claude-opus-5-5`                | medium, high, xhigh, max                                | Existing pinned, ready OAuth connection; adaptive thinking; explicit unchanged output cap; non-streaming JSON |
| `claude` | `claude-sonnet-5-5`              | medium, high, xhigh                                     | Same guarded OAuth/JSON contract; exact effort and model                                                      |
| `openai` | Explicit operator-supplied model | Only the profile's explicitly declared supported effort | Existing API-key lane; exact identity and bounded JSON contract; no inferred catalog availability             |

The seven Claude pairs are explicitly scoped. The Claude lane does not admit other models, low effort, or Sonnet max. Official documentation now supports Sonnet max, but the preserved ordinary source still clamps it to high. This lane cannot represent that as exact max. No global model registry or ordinary effort defaults were changed to add the seven pairs.

Primary public contracts: [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview), [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [effort and output accounting](https://platform.claude.com/docs/en/build-with-claude/effort), and the separate [Claude Code model configuration](https://code.claude.com/docs/en/model-config). These mutable documents were checked on the evidence date. API-key authentication and subscription OAuth are distinct; documentation does not establish a particular account's entitlement or third-party OAuth compatibility.

The bounded Claude lane sends no sampling controls. Its trusted request scope prevents the legacy formatter from synthesizing temperature 1; it does not delete supplied sampling fields. Explicit or late-injected temperature/top_p/top_k remain visible and are rejected at the final fence. Ordinary requests retain their prior sampling normalization. No client-visible bypass flag was introduced.

Capabilities, context limits, effort support and evidence remain explicit operator profile declarations. A listing, active connection or declaration is not a successful provider test. Unsupported or unknown contracts must not be silently substituted with another model, effort, account or paid provider. Codex OAuth/Responses and Antigravity execution remain unimplemented in this bounded lane; the OpenAI API-key lane is not a substitute for them.

## Native selection

The selector receives only currently eligible explicit model-and-effort options. A client-supplied effort is a hard constraint. For example, explicit Medium can offer both Opus Medium and Sonnet Medium; it does not authorize High or Max. Operator task preferences remain unchanged. Confidence is a provider-reported value, not measured correctness or permission.

Two or more eligible options use the configured native decision provider; exactly one uses the existing guarded execution with explicit `sole-eligible` / `no-decision`; zero returns `no-route`. Decision and execution receipts remain separate. Refusal, malformed selection, authentication/access/quota denial, cancellation and queued policy changes cannot authorize an unintended execution or hidden fallback.

Free Zen requires an explicit native `jev-1.13-free` binding and the actual free routing guard. These local fixtures establish no live free-Zen success or quota-reset scope. Existing paid selector contracts remain separate; no paid fallback is introduced.

## Pinned Hermes fixture boundary

The fixture uses original request-builder fragments from [Hermes commit 749cb638ff43f9ce5333c186a1e4f67d473aa4f2](https://github.com/NousResearch/hermes-agent/tree/749cb638ff43f9ce5333c186a1e4f67d473aa4f2), with its MIT license and byte-level provenance. Original assembly, effort and cap functions execute with named fixture collaborators; whole Hermes modules, configuration, dotenv, authentication and plugins are not imported.

An explicit fixture projection turns the captured SDK kwargs into JSON for the actual application handler. The Python OpenAI SDK is absent and was not installed. This proves request assembly plus the declared projection and application behavior, not SDK HTTP serialization, headers/retries, the full client driver or an installed Hermes version. Stream flags and sanitized-message collaborators supplied by the fixture are labeled as substitutions.

The custom profile's original default-Medium method executes in the fixture. Its Medium directive remains hard: a synthetic free Jev decision can choose Opus or Sonnet at Medium and then one exact execution. A configured output cap is required. Usual source-derived streaming/tools/continuation requests and omitted caps remain rejected with zero dispatches. The full Hermes agent is not yet compatible by default.

The overall decision-plus-execution deadline remains 30 seconds. Automatic OAuth refresh, streaming/tool continuation, broader execution contracts, optional-feature coexistence, recovery/evaluation UX and quality validation remain unfinished. No raw message excerpt was newly sent to a decision provider; live content-aware classification retains its separate privacy decision.
