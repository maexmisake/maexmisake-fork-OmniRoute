# Pinned Hermes builder fixture

This fixture executes selected original Hermes function bodies from commit
[749cb638ff43f9ce5333c186a1e4f67d473aa4f2](https://github.com/NousResearch/hermes-agent/commit/749cb638ff43f9ce5333c186a1e4f67d473aa4f2).
It then passes a declared JSON projection into the actual OmniRoute chat POST handler.

It proves **original source kwargs assembly plus application behavior with synthetic providers**.
It does not prove OpenAI SDK serialization, execution of the full Hermes client, Fernando’s installed
client configuration, live Zen access, model availability, or selection quality. No real provider
requests, sockets, credentials, or paid usage are involved.

## Source and license

- `upstream-fragments.json`: 23 exact function/constant line slices. The methods are lifted from their
  original class scope at runtime with indentation normalization; their bodies are unchanged.
- `provenance.json`: original repository URLs, full commit, Git blob IDs, source SHA256 hashes,
  fragment hashes and extraction method. Original module files are not vendored.
- `LICENSE`: original MIT License, Copyright (c) 2025 Nous Research.
- `build_request.py`: the closed fixture driver, written for this project.

The source receipts were checked against exact public files saved during preparation. The integration
test fixes the aggregate fragment hash and checks every fragment. Preserve the MIT notice when
copying the original fragments.

## What actually executes

The original `_build_chat_completions_kwargs` calls the original
`ChatCompletionsTransport.build_kwargs` and profile builder. The original custom profile effort
mapper, effort clamps, cap selector and base-profile pure methods execute. The default-Medium
case executes the original `CustomProfile.default_reasoning_config` method; it does not execute
the full main-loop capability/default resolver.

The Python driver uses `-I -B` and an explicit child environment containing only PATH and a synthetic
HOME. It never imports whole Hermes modules. AST loading accepts only the checked original
functions/constants. The original bodies receive limited builtins and explicit in-memory import
facades; unknown modules, provider identities and import attributes fail closed. An independent
socket guard rejects sockets and DNS. Canaries verify unknown import, unknown provider and socket
access fail. Fixture denials inherit from BaseException so the original compatibility catches of
Exception cannot swallow them; the import canary checks this inside the same suppression pattern.
This is a boundary around reviewed pinned functions, not a general hostile-Python sandbox.

Substitutions are returned in each capture:

- Synthetic agent/profile scalar state; no initialization or real configuration.
- Already-sanitized synthetic text/messages; identity message conversion and carrier shaping.
- Empty data-use and provider preferences; no ephemeral cap or fixed temperature.
- Closed facades for provider lookup, the temperature sentinel, auxiliary temperature lookup,
  Gemini predicates and unused Codex cache helpers.
- Custom fixture URL predicates and a non-Moonshot predicate. Unused developer-role constants
  and Codex cache functions raise if consulted.
- In-memory `create(**kwargs)` capture. No OpenAI package is installed or imported.
- Explicit driver streaming flags, described below.

## JSON projection and requests

The captured SDK kwargs retain `timeout: 5`. The declared JSON projection removes only this
SDK-only field. An `extra_body` mapping can merge only reviewed noncolliding fields; collisions
with existing body keys, reserved driver flags or timeout fail. Unknown kwargs also fail.

The ordinary combo name yields source-built `max_tokens: 64` and top-level
`reasoning_effort: medium/high`. No temperature is added by the source builder. Driver fixtures
then add `stream: false` for the supported text subset, or source-derived default
`stream: true`/`stream_options.include_usage` for rejection cases. These flags are **not execution
of Hermes’s streaming driver**. Tool schema inclusion comes from the executed builder. Continuation
history is synthetic, already sanitized input to that builder; tool execution and full history
sanitation do not run.

The actual-handler positives configure four synthetic model/effort profiles: Opus and Sonnet,
each Medium and High. Explicit effort stays a hard constraint, leaving two same-effort options
for the mock free `jev-1.13-free` selector. Distinct fake execution accounts prove exact account,
model and effort selection. No effort is silently omitted to make a decision possible.

Unsupported omitted-cap, streaming, tools and tool-continuation inputs are rejected before either
mock stage. Refusal, unauthenticated requests and pre-cancellation do not execute a model.
Unknown decision/execution costs remain null; mocked known zero remains zero. These are synthetic
receipts, not vendor prices or account-entitlement evidence.

## Run the focused integration test

From the implementation checkout, using the existing no-network guard:

```bash
env -i PATH="$PATH" \
  NODE_OPTIONS="--import=$PWD/scripts/ad-hoc/native-router-offline-guard.mjs" \
  OMNIROUTE_OFFLINE_AUDIT=local-fixtures TSX_DISABLE_CACHE=1 \
  DISABLE_SQLITE_AUTO_BACKUP=true API_KEY_SECRET=synthetic-hermes-fixture \
  node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts --test --test-reporter=tap \
  --test-concurrency=1 tests/integration/decision-hermes-pinned-client.test.ts
```

The existing test isolator gives the process a disposable database and plugin directory. Fetch is
intercepted in memory; the only two recognized destinations are the synthetic decision and execution
routes. Every attempted dispatch is counted before payload parsing; all other calls fail.

Optional `NATIVE_EVIDENCE_PATH` writes sanitized assertion traces containing model/effort,
stage counts and receipts. It omits request bodies, task excerpts and credentials.

Existing handler telemetry can log deferred Claude timeout messages after response completion
and a call-log write warning after database closure. The test must finish naturally and report
these limits; passing the two-stage journal assertions does not establish all telemetry cleanup
or crash durability.
