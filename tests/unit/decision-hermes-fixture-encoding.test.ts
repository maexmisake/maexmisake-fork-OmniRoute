import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The closed Hermes fixture drivers read UTF-8 JSON (PATCH-PIN.json carries non-ASCII text).
// A locale-dependent default (cp1252 on Windows) silently corrupts those reads, so every text
// read must name its encoding. `-X warn_default_encoding -W error::EncodingWarning` makes the
// missing encoding fail on any platform, not only where the locale differs from UTF-8.
const FIXTURES = new URL("../fixtures/decisionPolicy/", import.meta.url);
const DRIVERS = [
  "hermesEffort/build_request.py",
  "hermesPinned/build_request.py",
  "hermesSDK/sdk_stdio_client.py",
  "hermesTools/tool_protocol_fixture.py",
];

function strictRun(driver: string, input: string) {
  return spawnSync(
    "python3",
    [
      "-I",
      "-B",
      "-X",
      "warn_default_encoding",
      "-W",
      "error::EncodingWarning",
      fileURLToPath(new URL(driver, FIXTURES)),
    ],
    {
      input,
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent-closed-hermes-fixture-home" },
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 524288,
    }
  );
}

test("fixture drivers never decode text with the platform default encoding", () => {
  for (const driver of DRIVERS) {
    const source = readFileSync(new URL(driver, FIXTURES), "utf8");
    assert.doesNotMatch(source, /\.read_text\(\)/, `${driver} read_text() without encoding`);
    assert.doesNotMatch(source, /sys\.stdin\.read(line)?\(/, `${driver} text-mode stdin`);
    assert.doesNotMatch(source, /\bopen\((?![^)]*(encoding=|"rb"|'rb'))/, `${driver} open()`);
  }
});

test("effort driver reads its UTF-8 patch pin under strict encoding warnings", () => {
  const result = strictRun(
    "hermesEffort/build_request.py",
    JSON.stringify({ case: "delegated-unset" })
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test("pinned driver runs under strict encoding warnings", () => {
  const result = strictRun(
    "hermesPinned/build_request.py",
    JSON.stringify({ case: "default-medium" })
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).body.reasoning_effort, "medium");
});

test("tool protocol driver runs under strict encoding warnings", () => {
  const result = strictRun("hermesTools/tool_protocol_fixture.py", "");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(typeof JSON.parse(result.stdout), "object");
});
