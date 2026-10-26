import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const fixture = fileURLToPath(
  new URL("../fixtures/decisionPolicy/hermesEffort/build_request.py", import.meta.url)
);
type Capture = {
  ok: boolean;
  error?: string;
  captureCreateCalls: number;
  capturedKwargs?: Record<string, unknown>;
  body?: Record<string, unknown>;
  executedSourceFunctions?: string[];
  sdkWireCaptured: boolean;
  fullHermesExecuted: boolean;
  wireReasoningConfig?: unknown;
  ephemeralOffRemaining?: boolean;
  driverFlags?: unknown;
  defaultResolverSourceKind?: string;
};
function capture(caseName: string, extra: Record<string, unknown> = {}): Capture {
  const result = spawnSync("python3", ["-I", "-B", fixture], {
    input: JSON.stringify({ case: caseName, ...extra }),
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent-closed-hermes-fixture-home" },
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 524288,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Capture;
}

test("normal custom unset still emits Medium through the pinned main builder", () => {
  const result = capture("ordinary-custom-unset");
  assert.equal(result.ok, true);
  assert.equal(result.capturedKwargs?.reasoning_effort, "medium");
  assert.deepEqual(result.wireReasoningConfig, { enabled: true, effort: "medium" });
});

test("explicit opt-in omits the default through real main-loop/default/profile functions", () => {
  const result = capture("delegated-unset");
  assert.equal(result.ok, true);
  assert.equal(result.captureCreateCalls, 1);
  assert.equal(result.capturedKwargs?.reasoning_effort, undefined);
  assert.equal(result.capturedKwargs?.extra_body, undefined);
  assert.equal(result.wireReasoningConfig, null);
  assert.equal(result.sdkWireCaptured, false);
  assert.equal(result.fullHermesExecuted, false);
  assert.equal(
    result.defaultResolverSourceKind,
    "previously-retrieved-official-web-rendered-fragment"
  );
  for (const name of [
    "build_api_kwargs",
    "_build_api_kwargs_for_mode",
    "_reasoning_config_for_wire",
    "unset_reasoning_default",
    "_build_chat_completions_kwargs",
    "build_kwargs",
    "_build_kwargs_from_profile",
  ])
    assert.ok(
      result.executedSourceFunctions?.some((value) => value.endsWith(":" + name)),
      name
    );
});

for (const effort of ["medium", "high"]) {
  test(`explicit ${effort} remains a hard wire instruction with delegation enabled`, () => {
    const result = capture("explicit-" + effort);
    const original = capture("ordinary-custom-" + effort);
    assert.equal(result.capturedKwargs?.reasoning_effort, effort);
    assert.deepEqual(result.capturedKwargs, original.capturedKwargs);
  });
}

for (const name of ["explicit-off", "explicit-none", "recovery-off"]) {
  test(`${name} remains explicit reasoning none, never default delegation`, () => {
    const result = capture(name);
    assert.equal(result.capturedKwargs?.reasoning_effort, "none");
    assert.equal(result.body?.reasoning_effort, "none");
    assert.equal(result.ephemeralOffRemaining, false);
  });
}

test("ordinary custom explicit off is unchanged", () => {
  assert.deepEqual(
    capture("explicit-off").capturedKwargs,
    capture("ordinary-custom-off").capturedKwargs
  );
});

for (const name of ["recovery-effort-rejected", "recovery-disable-rejected"]) {
  test(`${name} retains Hermes recovery omission instead of restoring Medium`, () => {
    const result = capture(name);
    assert.equal(result.ok, true);
    assert.equal(result.capturedKwargs?.reasoning_effort, undefined);
    assert.equal(result.capturedKwargs?.extra_body, undefined);
    assert.equal(result.wireReasoningConfig, null);
  });
}

for (const name of [
  "missing-profile",
  "wrong-profile",
  "profile-lookup-error",
  "wrong-destination",
  "lookalike-destination",
  "wrong-combo",
  "disabled",
  "unsupported-api-mode",
]) {
  test(`${name} stops before capture-only create or any SDK request`, () => {
    const result = capture(name);
    assert.equal(result.ok, false);
    assert.equal(result.captureCreateCalls, 0);
    assert.equal(result.capturedKwargs, undefined);
    assert.match(result.error ?? "", /^omniroute_delegation_/);
    assert.equal(result.sdkWireCaptured, false);
  });
}

test("unpatched main-builder control demonstrates the missing-profile explicit High loss", () => {
  const result = capture("unpatched-missing-profile");
  assert.equal(result.ok, true);
  assert.equal(result.captureCreateCalls, 1);
  assert.deepEqual(result.wireReasoningConfig, { enabled: true, effort: "high" });
  assert.equal(result.capturedKwargs?.reasoning_effort, undefined);
});

test("explicit request override remains explicit after profile-default delegation", () => {
  assert.equal(capture("override-medium").capturedKwargs?.reasoning_effort, "medium");
});

test("a supplied continuation history runs the same builder without effort or provenance carriers", () => {
  const messages = [
    { role: "user", content: "Synthetic task" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "synthetic-call",
          type: "function",
          function: { name: "synthetic_tool", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "synthetic-call", content: "Synthetic result" },
  ];
  const result = capture("delegated-unset", { messages });
  assert.equal(result.capturedKwargs?.reasoning_effort, undefined);
  assert.deepEqual(result.capturedKwargs?.messages, messages);
  for (const key of [
    "provider",
    "base_url",
    "_approved_binding",
    "delegation",
    "wireReasoningConfig",
  ])
    assert.equal(Object.hasOwn(result.capturedKwargs!, key), false);
  assert.deepEqual(result.driverFlags, { stream: true, stream_options: { include_usage: true } });
});

test("patch artifact and pinned source provenance are internally bound without inventing raw hashes", () => {
  const packageRoot = new URL("../../scripts/ad-hoc/hermes-effort-delegation/", import.meta.url);
  const pin = JSON.parse(readFileSync(new URL("PATCH-PIN.json", packageRoot), "utf8"));
  const patch = readFileSync(new URL("hermes-749cb638.patch", packageRoot));
  assert.equal(createHash("sha256").update(patch).digest("hex"), pin.patchSHA256);
  assert.equal(pin.installationPerformed, false);
  assert.equal(pin.ordinaryCustomChanged, false);
  const fragments = JSON.parse(
    readFileSync(
      new URL("../fixtures/decisionPolicy/hermesEffort/upstream-fragments.json", import.meta.url),
      "utf8"
    )
  );
  const resolver = fragments.fragments.find(
    (row: { qualifiedName: string }) => row.qualifiedName === "unset_reasoning_default"
  );
  assert.equal(resolver.wholeModuleSHA256, null);
  assert.equal(resolver.sourceKind, "previously-retrieved-official-web-rendered-fragment");
});
