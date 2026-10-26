import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("actual pinned Hermes ID helpers preserve gateway IDs without widening legacy facades", () => {
  const fixture = fileURLToPath(
    new URL("../fixtures/decisionPolicy/hermesTools/tool_protocol_fixture.py", import.meta.url)
  );
  const fragments = readFileSync(
    new URL("../fixtures/decisionPolicy/hermesTools/tool-id-fragments.json", import.meta.url)
  );
  const provenance = JSON.parse(
    readFileSync(
      new URL("../fixtures/decisionPolicy/hermesTools/tool-id-provenance.json", import.meta.url),
      "utf8"
    )
  );
  assert.equal(createHash("sha256").update(fragments).digest("hex"), provenance.fragmentFileSHA256);
  assert.equal(provenance.commit, "749cb638ff43f9ce5333c186a1e4f67d473aa4f2");
  const code = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("closed_hermes_id_fixture",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
agent=module.agent_fixture(pinned_ids=True)
identifier="gmc_"+"0"*32+"_0"
assert agent._split_responses_tool_id(identifier)==(identifier,None)
assert agent._derive_responses_function_call_id(identifier,None)=="fc_"+identifier
assert agent._split_responses_tool_id(identifier+"|fc_synthetic")== (identifier,"fc_synthetic")
assert agent._derive_responses_function_call_id(identifier,"fc_synthetic")=="fc_synthetic"
try:
    module.agent_fixture()._split_responses_tool_id(identifier)
    raise AssertionError("Legacy closed facade was widened")
except module.ClosedBoundaryError:
    pass
try:
    agent._derive_responses_function_call_id("",None)
    raise AssertionError("Unreviewed random fallback ran")
except module.ClosedBoundaryError:
    pass
print(json.dumps({"pinnedBodiesExecuted":2,"gatewayIDsPreserved":True,"legacyBoundaryPreserved":True,"randomFallbackDenied":True,"actualToolsRun":False,"providerCalls":0}))
`;
  const result = spawnSync("python3", ["-I", "-B", "-c", code, fixture], {
    env: { PATH: process.env.PATH! },
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    pinnedBodiesExecuted: 2,
    gatewayIDsPreserved: true,
    legacyBoundaryPreserved: true,
    randomFallbackDenied: true,
    actualToolsRun: false,
    providerCalls: 0,
  });
});
