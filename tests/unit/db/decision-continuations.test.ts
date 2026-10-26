import "../../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createApiKey } from "../../../src/lib/db/apiKeys.ts";
import { createCombo, updateCombo } from "../../../src/lib/db/combos.ts";
import {
  createProviderConnection,
  updateProviderConnection,
} from "../../../src/lib/db/providers.ts";
import { getDbInstance, resetDbInstance } from "../../../src/lib/db/core.ts";
import { getKeyQuotaStatus, upsertKeyQuotaLimits } from "../../../src/lib/db/keyQuota.ts";
import {
  reserveDecisionAttempt,
  startDecisionAttempt,
  settleDecisionAttempt,
  finishDecisionApplication,
  decisionAuthorityStamp,
  readDecisionAttempts,
  type AttemptIdentity,
  cancelUnstartedDecision,
} from "../../../src/lib/db/decisionAttempts.ts";
import {
  issueToolContinuation,
  prepareToolContinuation,
  claimToolContinuation,
  readToolContinuations,
  finishToolContinuation,
  TOOL_CONTINUATION_LIMITS,
  type ToolGroupProof,
  type ToolContinuationRequest,
  assertToolContinuationClaim,
  commitToolContinuation,
  commitToolContinuationEnd,
} from "../../../src/lib/db/decisionContinuations.ts";

const prefix = JSON.stringify([
  { role: "user", content: "synthetic-private-prefix" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "fixture_call",
        type: "function",
        function: { name: "synthetic_lookup", arguments: '{"value":"synthetic-private-argument"}' },
      },
    ],
  },
]);
const contract = JSON.stringify({
  tools: [
    { type: "function", function: { name: "synthetic_lookup", parameters: { type: "object" } } },
  ],
  tool_choice: "auto",
});
function proof(): ToolGroupProof {
  return {
    clientPrefixJSON: prefix,
    toolContractJSON: contract,
    calls: [
      {
        id: "fixture_call",
        name: "synthetic_lookup",
        arguments: '{"value":"synthetic-private-argument"}',
      },
    ],
  };
}
async function fixture() {
  const key = await createApiKey("synthetic-continuation-key", "synthetic");
  const combo = await createCombo({
    name: "synthetic-tools-" + randomUUID(),
    strategy: "priority",
    models: ["claude/claude-opus-5-5"],
    config: { decisionPolicy: { enabled: true, applicationMode: "bounded-v1" } },
  });
  const connection = await createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "synthetic-tools-account",
    accessToken: "synthetic-tools-token",
    isActive: true,
    providerSpecificData: {},
  });
  const identity: AttemptIdentity = {
    id: randomUUID(),
    keyId: key.id,
    comboId: String(combo.id),
    candidateId: "fixture",
    provider: "claude",
    model: "claude-opus-5-5",
    connectionId: String(connection.id),
    effort: "medium",
    requestedModel: String(combo.name),
    lane: "execution",
  };
  const expectedPolicy = JSON.stringify({ enabled: true, applicationMode: "bounded-v1" });
  const expectedAuthority = decisionAuthorityStamp(identity, expectedPolicy);
  reserveDecisionAttempt(identity);
  startDecisionAttempt(identity);
  settleDecisionAttempt(identity, { status: 200, input: 2, output: 3, cost: null });
  finishDecisionApplication(identity.id, 200);
  const request: ToolContinuationRequest = {
    keyId: key.id,
    comboId: String(combo.id),
    history: [proof()],
    completedCallIds: ["fixture_call"],
  };
  return { identity, expectedPolicy, expectedAuthority, request };
}
function fresh(origin: AttemptIdentity): AttemptIdentity {
  const { leaseOwner: _owner, ...rest } = origin;
  return { ...rest, id: randomUUID(), requestId: undefined, parentAttemptId: undefined };
}
function durableRpmCount(keyId: string): number {
  // A worker can cross a minute boundary; assert persisted increments, not decaying window weight.
  const row = getDbInstance()
    .prepare(
      "SELECT SUM(consumed) n FROM api_key_quota_counters WHERE api_key_id=? AND dimension_key='key-quota:rpm'"
    )
    .get(keyId) as { n: number };
  return row.n;
}
after(() => resetDbInstance());
test("metadata authority pins exact binding and a continuation counts its own request", async () => {
  const f = await fixture();
  const turnId = issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  const prepared = prepareToolContinuation(f.request);
  assert.equal(prepared.turnId, turnId);
  assert.equal(prepared.binding.connectionId, f.identity.connectionId);
  const next = fresh(f.identity);
  claimToolContinuation(f.request, next);
  assert.equal(readDecisionAttempts(f.identity.keyId).length, 2);
  startDecisionAttempt(next);
  assert.equal(getKeyQuotaStatus(next.keyId).counters.rpmUsed, 2);
  assert.equal(next.parentAttemptId, undefined);
  assert.notEqual(next.leaseOwner, f.identity.leaseOwner);
  const publicRows = JSON.stringify(readToolContinuations(next.keyId, next.comboId));
  for (const secret of [
    String(f.identity.leaseOwner),
    "synthetic-private-prefix",
    "synthetic-private-argument",
  ])
    assert.equal(publicRows.includes(secret), false);
  assert.equal(publicRows.includes("_mac"), false);
});
for (const change of [
  "key",
  "combo",
  "prefix",
  "contract",
  "descriptor",
  "missing-result",
  "duplicate-result",
  "unissued-result",
]) {
  test(`a ${change} mismatch grants no new reservation`, async () => {
    const f = await fixture();
    issueToolContinuation(f.identity, {
      ...proof(),
      expectedPolicy: f.expectedPolicy,
      expectedAuthority: f.expectedAuthority,
    });
    const request = structuredClone(f.request);
    if (change === "key") request.keyId = randomUUID();
    if (change === "combo") request.comboId = randomUUID();
    if (change === "prefix") request.history = [{ ...proof(), clientPrefixJSON: "[]" }];
    if (change === "contract") request.history = [{ ...proof(), toolContractJSON: "{}" }];
    if (change === "descriptor")
      request.history = [
        { ...proof(), calls: [{ ...proof().calls[0], name: "other", arguments: "{}" }] },
      ];
    if (change === "missing-result") request.completedCallIds = [];
    if (change === "duplicate-result") request.completedCallIds = ["fixture_call", "fixture_call"];
    if (change === "unissued-result") request.completedCallIds = ["unknown_call"];
    assert.throws(() => prepareToolContinuation(request));
    assert.throws(() => claimToolContinuation(request, fresh(f.identity)));
    assert.equal(readDecisionAttempts(f.identity.keyId).length, 1);
  });
}
test("public or forged origin identity cannot mint metadata", async () => {
  const f = await fixture();
  const issue = {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  };
  const { leaseOwner: _owner, ...publicIdentity } = f.identity;
  assert.throws(() => issueToolContinuation(publicIdentity, issue), /decision_lease_owner/);
  assert.throws(
    () => issueToolContinuation({ ...f.identity, leaseOwner: randomUUID() }, issue),
    /decision_lease_owner/
  );
  assert.equal(readToolContinuations(f.identity.keyId, f.identity.comboId).length, 0);
});
for (const change of ["incomplete-provider", "failed-application", "policy", "connection"]) {
  test(`origin ${change} cannot become current continuation authority`, async () => {
    const f = await fixture();
    if (change === "incomplete-provider")
      getDbInstance()
        .prepare("UPDATE decision_application_attempts SET state='unknown' WHERE id=?")
        .run(f.identity.id);
    if (change === "failed-application") finishDecisionApplication(f.identity.id, 499);
    if (change === "policy")
      await updateCombo(f.identity.comboId, { config: { decisionPolicy: { enabled: false } } });
    if (change === "connection")
      await updateProviderConnection(f.identity.connectionId, { isActive: false });
    assert.throws(() =>
      issueToolContinuation(f.identity, {
        ...proof(),
        expectedPolicy: f.expectedPolicy,
        expectedAuthority: f.expectedAuthority,
      })
    );
    assert.equal(readToolContinuations(f.identity.keyId, f.identity.comboId).length, 0);
  });
}
test("prepared authority is rechecked atomically after policy or account mutation", async () => {
  for (const change of ["policy", "account"]) {
    const f = await fixture();
    issueToolContinuation(f.identity, {
      ...proof(),
      expectedPolicy: f.expectedPolicy,
      expectedAuthority: f.expectedAuthority,
    });
    prepareToolContinuation(f.request);
    if (change === "policy")
      await updateCombo(f.identity.comboId, { config: { decisionPolicy: { enabled: false } } });
    else await updateProviderConnection(f.identity.connectionId, { isActive: false });
    assert.throws(() => claimToolContinuation(f.request, fresh(f.identity)), /authority_changed/);
    assert.equal(readDecisionAttempts(f.identity.keyId).length, 1);
  }
});
test("claim and reservation roll back together when either write fails", async () => {
  for (const table of ["decision_tool_turns", "decision_application_attempts"]) {
    const f = await fixture();
    issueToolContinuation(f.identity, {
      ...proof(),
      expectedPolicy: f.expectedPolicy,
      expectedAuthority: f.expectedAuthority,
    });
    const action = table === "decision_tool_turns" ? "UPDATE" : "INSERT";
    getDbInstance().exec(
      `CREATE TEMP TRIGGER fail_tool_claim BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic claim fault'); END`
    );
    try {
      assert.throws(() => claimToolContinuation(f.request, fresh(f.identity)));
    } finally {
      getDbInstance().exec("DROP TRIGGER fail_tool_claim");
    }
    assert.equal(readDecisionAttempts(f.identity.keyId).length, 1);
    assert.equal(readToolContinuations(f.identity.keyId, f.identity.comboId)[0].state, "issued");
  }
});
test("restart preserves metadata but missing or wrong signed cache authorizes no new attempt", async () => {
  const f = await fixture();
  const blocks = JSON.stringify([
    { type: "thinking", thinking: "", signature: "synthetic-not-a-real-signature" },
  ]);
  issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
    thinkingBlocksJSON: blocks,
  });
  resetDbInstance();
  assert.equal(prepareToolContinuation(f.request).replayOrigins[0].requiresThinkingReplay, true);
  assert.throws(() => claimToolContinuation(f.request, fresh(f.identity)), /replay_missing/);
  assert.throws(
    () => claimToolContinuation(f.request, fresh(f.identity), { [f.identity.id]: "[]" }),
    /replay_mismatch/
  );
  assert.equal(readDecisionAttempts(f.identity.keyId).length, 1);
  claimToolContinuation(f.request, fresh(f.identity), { [f.identity.id]: blocks });
  assert.equal(readDecisionAttempts(f.identity.keyId).length, 2);
});
test("only a provably unstarted expired claim may be reserved again", async () => {
  const f = await fixture();
  issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  const first = fresh(f.identity);
  claimToolContinuation(f.request, first);
  assert.throws(() => claimToolContinuation(f.request, fresh(f.identity)), /claimed/);
  getDbInstance()
    .prepare("UPDATE decision_application_attempts SET lease_expires_at=0 WHERE id=?")
    .run(first.id);
  const second = fresh(f.identity);
  claimToolContinuation(f.request, second);
  assert.throws(() => startDecisionAttempt(first), /decision_lease_expired/);
  assert.notEqual(first.leaseOwner, second.leaseOwner);
  assert.equal(
    readDecisionAttempts(first.keyId).find((row) => row.id === first.id)!.state,
    "cancelled"
  );
});
test("owner-fenced known-zero cancellation can retry immediately, unknown is not free", async () => {
  for (const unknown of [false, true]) {
    const f = await fixture();
    issueToolContinuation(f.identity, {
      ...proof(),
      expectedPolicy: f.expectedPolicy,
      expectedAuthority: f.expectedAuthority,
    });
    const first = fresh(f.identity);
    claimToolContinuation(f.request, first);
    cancelUnstartedDecision(first.id, first.leaseOwner);
    if (unknown)
      getDbInstance()
        .prepare("UPDATE decision_application_attempts SET cost_usd=NULL WHERE id=?")
        .run(first.id);
    if (unknown)
      assert.throws(() => claimToolContinuation(f.request, fresh(f.identity)), /uncertain_attempt/);
    else claimToolContinuation(f.request, fresh(f.identity));
    assert.throws(() => startDecisionAttempt(first), /decision_lease_expired/);
    assert.equal(getKeyQuotaStatus(first.keyId).counters.rpmUsed, 1);
  }
});
test("historical repeated IDs are ancestry-bound and each signed occurrence is required", async () => {
  const f = await fixture();
  const blocks = '[{"type":"thinking","thinking":"","signature":"synthetic-first"}]';
  const root = issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
    thinkingBlocksJSON: blocks,
  });
  const next = fresh(f.identity);
  claimToolContinuation(f.request, next, { [f.identity.id]: blocks });
  startDecisionAttempt(next);
  settleDecisionAttempt(next, { status: 200, input: 3, output: 2, cost: null });
  finishDecisionApplication(next.id, 200);
  const secondProof = {
    ...proof(),
    clientPrefixJSON: JSON.stringify([
      ...JSON.parse(prefix),
      { role: "tool", tool_call_id: "fixture_call", content: "Synthetic result" },
      ...JSON.parse(prefix),
    ]),
  };
  const secondBlocks = '[{"type":"thinking","thinking":"","signature":"synthetic-second"}]';
  issueToolContinuation(next, {
    ...secondProof,
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: decisionAuthorityStamp(next, f.expectedPolicy),
    previousTurnId: root,
    thinkingBlocksJSON: secondBlocks,
  });
  const request = { ...f.request, history: [proof(), secondProof] };
  assert.equal(prepareToolContinuation(request).replayOrigins.length, 2);
  assert.throws(
    () => claimToolContinuation(request, fresh(next), { [next.id]: secondBlocks }),
    /replay_missing/
  );
  assert.throws(
    () =>
      claimToolContinuation(request, fresh(next), {
        [f.identity.id]: secondBlocks,
        [next.id]: blocks,
      }),
    /replay_mismatch/
  );
  claimToolContinuation(request, fresh(next), { [f.identity.id]: blocks, [next.id]: secondBlocks });
});
test("expired pins and duplicate/current-group IDs fail closed", async () => {
  const f = await fixture();
  const turn = issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  getDbInstance().prepare("UPDATE decision_tool_turns SET expires_at=0 WHERE id=?").run(turn);
  assert.throws(() => prepareToolContinuation(f.request));
  const g = await fixture();
  assert.throws(
    () =>
      issueToolContinuation(g.identity, {
        ...proof(),
        calls: [proof().calls[0], proof().calls[0]],
        expectedPolicy: g.expectedPolicy,
        expectedAuthority: g.expectedAuthority,
      }),
    /calls/
  );
  assert.equal(TOOL_CONTINUATION_LIMITS.calls, 32);
});
const workerCode = `
import { randomUUID } from 'node:crypto';
const { claimToolContinuation } = await import('./src/lib/db/decisionContinuations.ts');
const { startDecisionAttempt } = await import('./src/lib/db/decisionAttempts.ts');
const { getDbInstance } = await import('./src/lib/db/core.ts');
let input='';for await(const chunk of process.stdin)input+=chunk;
const fixture=JSON.parse(input);
try {
 if(fixture.crash) {
  const db=getDbInstance();
  if(!['better-sqlite3','node:sqlite'].includes(db.driver))throw new Error('synthetic crash fixture requires native SQLite function support');
  db.raw.function('synthetic_abort_process',()=>process.kill(process.pid,'SIGKILL'));
  db.exec("CREATE TEMP TRIGGER crash_claim BEFORE UPDATE ON decision_tool_turns BEGIN SELECT synthetic_abort_process(); END");
 }
 const identity={...fixture.identity,id:randomUUID()};
 claimToolContinuation(fixture.request,identity);
 if(fixture.start)startDecisionAttempt(identity);
 process.stdout.write('RESULT '+JSON.stringify({ok:true,id:identity.id})+'\\n');
 if(fixture.wait)setInterval(()=>{},1000);
} catch(error) {
 process.stdout.write('RESULT '+JSON.stringify({ok:false,error:error.message})+'\\n');
}
`;
function worker(f: Awaited<ReturnType<typeof fixture>>, wait = false, crash = false) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", workerCode],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH!,
        DATA_DIR: process.env.DATA_DIR!,
        API_KEY_SECRET: "synthetic-continuation-worker",
        DISABLE_SQLITE_AUTO_BACKUP: "true",
        NODE_OPTIONS: process.env.NODE_OPTIONS!,
        OMNIROUTE_OFFLINE_AUDIT: "no-network",
        TSX_DISABLE_CACHE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  let output = "";
  const result = new Promise<{ ok: boolean; id?: string; error?: string }>((resolve, reject) => {
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((entry) => entry.startsWith("RESULT "));
      if (line) resolve(JSON.parse(line.slice(7)));
    });
    child.on("exit", () => {
      if (!output.includes("RESULT ")) reject(new Error("synthetic worker exited without result"));
    });
  });
  const exit = once(child, "exit");
  child.stdin.end(
    JSON.stringify({ request: f.request, identity: fresh(f.identity), start: true, wait, crash })
  );
  return { child, result, exit };
}
test("independent workers cannot claim the same group twice", async () => {
  const f = await fixture();
  issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  const first = worker(f),
    second = worker(f);
  const results = await Promise.all([first.result, second.result]);
  await Promise.all([first.exit, second.exit]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(readDecisionAttempts(f.identity.keyId).length, 2);
  assert.equal(durableRpmCount(f.identity.keyId), 2);
});
test("a killed started worker remains non-replayable with unknown cost after restart", async () => {
  const f = await fixture();
  issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  const running = worker(f, true);
  try {
    const result = await running.result;
    assert.equal(result.ok, true);
    running.child.kill("SIGKILL");
    await running.exit;
    getDbInstance()
      .prepare("UPDATE decision_application_attempts SET lease_expires_at=0 WHERE id=?")
      .run(result.id);
    resetDbInstance();
    assert.throws(() => claimToolContinuation(f.request, fresh(f.identity)), /uncertain_attempt/);
    const rows = readDecisionAttempts(f.identity.keyId);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.id === result.id)!.cost_usd, null);
    assert.equal(durableRpmCount(f.identity.keyId), 2);
  } finally {
    running.child.kill("SIGKILL");
  }
});
test("process death inside claim transaction rolls back both reservation and pin state", async () => {
  const f = await fixture();
  issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  const crashed = worker(f, false, true);
  await assert.rejects(
    crashed.result.then((result) => {
      assert.fail(`synthetic worker unexpectedly returned: ${JSON.stringify(result)}`);
    }),
    /without result/
  );
  const [_code, signal] = await crashed.exit;
  assert.equal(signal, "SIGKILL");
  resetDbInstance();
  assert.equal(readDecisionAttempts(f.identity.keyId).length, 1);
  assert.equal(readToolContinuations(f.identity.keyId, f.identity.comboId)[0].state, "issued");
  claimToolContinuation(f.request, fresh(f.identity));
  assert.equal(readDecisionAttempts(f.identity.keyId).length, 2);
});
test("handover exemptions, changed target and forged claim owner do not create a continuation execution", async () => {
  const f = await fixture();
  issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  for (const changed of [
    { parentAttemptId: f.identity.id },
    { requestId: f.identity.id },
    { leaseOwner: f.identity.leaseOwner },
    { effort: "high" },
    { connectionId: randomUUID() },
  ]) {
    assert.throws(() => claimToolContinuation(f.request, { ...fresh(f.identity), ...changed }));
  }
  assert.equal(readDecisionAttempts(f.identity.keyId).length, 1);
});
test("proof byte/group bounds and incomplete thinking cannot mint metadata", async () => {
  const f = await fixture();
  const base = {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  };
  for (const changed of [
    { calls: Array.from({ length: 33 }, (_, i) => ({ ...proof().calls[0], id: "call_" + i })) },
    { clientPrefixJSON: JSON.stringify(["x".repeat(TOOL_CONTINUATION_LIMITS.canonicalBytes)]) },
    { thinkingBlocksJSON: "[]" },
    { thinkingBlocksJSON: '[{"type":"thinking","thinking":"","signature":""}]' },
  ])
    assert.throws(() => issueToolContinuation(f.identity, { ...base, ...changed }));
  assert.throws(
    () => prepareToolContinuation({ ...f.request, history: Array(33).fill(proof()) }),
    /history/
  );
  assert.equal(readToolContinuations(f.identity.keyId, f.identity.comboId).length, 0);
});
test("issued-call metadata must remain complete, and metadata contains no payload", async () => {
  const f = await fixture();
  const id = issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  const rows = getDbInstance().prepare("SELECT * FROM decision_tool_turns WHERE id=?").get(id);
  const calls = getDbInstance()
    .prepare("SELECT * FROM decision_tool_calls WHERE turn_id=?")
    .all(id);
  const serialized = JSON.stringify([rows, calls]);
  for (const value of [
    "synthetic-private-prefix",
    "synthetic-private-argument",
    "synthetic_lookup",
    String(f.identity.leaseOwner),
  ])
    assert.equal(serialized.includes(value), false);
  getDbInstance().prepare("DELETE FROM decision_tool_calls WHERE turn_id=?").run(id);
  assert.throws(() => prepareToolContinuation(f.request));
  assert.throws(() => claimToolContinuation(f.request, fresh(f.identity)));
  assert.equal(readDecisionAttempts(f.identity.keyId).length, 1);
});
test("a completed claimed execution is consumed once and cannot reopen the old group", async () => {
  const f = await fixture();
  const id = issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  const next = fresh(f.identity);
  claimToolContinuation(f.request, next);
  startDecisionAttempt(next);
  settleDecisionAttempt(next, { status: 200, input: 3, output: 4, cost: null });
  finishDecisionApplication(next.id, 200);
  finishToolContinuation(id, next);
  assert.throws(() => claimToolContinuation(f.request, fresh(f.identity)));
  assert.throws(() => finishToolContinuation(id, { ...next, leaseOwner: randomUUID() }));
  assert.equal(readDecisionAttempts(f.identity.keyId).length, 2);
});
test("completed descendants cannot reset depth by omitting or changing their parent", async () => {
  const f = await fixture();
  const root = issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  const next = fresh(f.identity);
  claimToolContinuation(f.request, next);
  startDecisionAttempt(next);
  settleDecisionAttempt(next, { status: 200, input: 2, output: 3, cost: null });
  finishDecisionApplication(next.id, 200);
  const options = {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: decisionAuthorityStamp(next, f.expectedPolicy),
  };
  assert.throws(() => issueToolContinuation(next, options), /previous_required/);
  assert.throws(
    () => issueToolContinuation(next, { ...options, previousTurnId: randomUUID() }),
    /previous/
  );
  issueToolContinuation(next, { ...options, previousTurnId: root });
  assert.equal(
    readToolContinuations(next.keyId, next.comboId).find(
      (row) => row.source_attempt_id === next.id
    )!.depth,
    1
  );
});
test("stale origin cannot mint a new root after its original lifetime", async () => {
  const f = await fixture();
  getDbInstance()
    .prepare(
      "UPDATE decision_application_attempts SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?"
    )
    .run(f.identity.id);
  assert.throws(
    () =>
      issueToolContinuation(f.identity, {
        ...proof(),
        expectedPolicy: f.expectedPolicy,
        expectedAuthority: f.expectedAuthority,
      }),
    /origin_expired/
  );
});
test("cleanup retains expired lineage while a claimed descendant could still attempt a new root", async () => {
  const f = await fixture();
  const root = issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  const descendant = fresh(f.identity);
  claimToolContinuation(f.request, descendant);
  startDecisionAttempt(descendant);
  settleDecisionAttempt(descendant, { status: 200, input: 2, output: 3, cost: null });
  finishDecisionApplication(descendant.id, 200);
  const db = getDbInstance();
  db.prepare("UPDATE decision_tool_turns SET expires_at=0 WHERE id=?").run(root);
  db.prepare("UPDATE decision_application_attempts SET created_at='2000-01-01' WHERE id=?").run(
    f.identity.id
  );
  const unrelated = fresh(f.identity);
  completeSynthetic(unrelated);
  issueToolContinuation(unrelated, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: decisionAuthorityStamp(unrelated, f.expectedPolicy),
  });
  assert.throws(
    () =>
      issueToolContinuation(descendant, {
        ...proof(),
        expectedPolicy: f.expectedPolicy,
        expectedAuthority: decisionAuthorityStamp(descendant, f.expectedPolicy),
      }),
    /previous_required/
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) n FROM decision_tool_turns WHERE id=?").get(root) as { n: number })
      .n,
    1
  );
  db.prepare("UPDATE decision_application_attempts SET created_at='2000-01-01' WHERE id=?").run(
    descendant.id
  );
  const later = fresh(f.identity);
  completeSynthetic(later);
  issueToolContinuation(later, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: decisionAuthorityStamp(later, f.expectedPolicy),
  });
  assert.equal(
    (db.prepare("SELECT COUNT(*) n FROM decision_tool_turns WHERE id=?").get(root) as { n: number })
      .n,
    0
  );
  assert.throws(
    () =>
      issueToolContinuation(descendant, {
        ...proof(),
        expectedPolicy: f.expectedPolicy,
        expectedAuthority: decisionAuthorityStamp(descendant, f.expectedPolicy),
      }),
    /origin_expired/
  );
});
test("the required final-send guard rejects post-claim policy and stale-owner changes", async () => {
  const f = await fixture();
  issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  const next = fresh(f.identity);
  claimToolContinuation(f.request, next);
  assertToolContinuationClaim(f.request, next);
  assert.throws(
    () => assertToolContinuationClaim(f.request, { ...next, leaseOwner: randomUUID() }),
    /decision_lease_owner/
  );
  await updateCombo(f.identity.comboId, { config: { decisionPolicy: { enabled: false } } });
  assert.throws(() => assertToolContinuationClaim(f.request, next), /authority_changed/);
  assert.equal(getKeyQuotaStatus(next.keyId).counters.rpmUsed, 1);
});
test("a final guard recognizes only its own already-counted request at the exact RPM limit", async () => {
  const f = await fixture();
  await upsertKeyQuotaLimits(f.identity.keyId, { rpmLimit: 1 });
  issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  assert.throws(() => prepareToolContinuation(f.request), /decision_request_quota_exhausted/);
  await upsertKeyQuotaLimits(f.identity.keyId, { rpmLimit: 2 });
  const next = fresh(f.identity);
  claimToolContinuation(f.request, next);
  startDecisionAttempt(next);
  assert.equal(getKeyQuotaStatus(next.keyId).counters.rpmUsed, 2);
  assertToolContinuationClaim(f.request, next);
  assert.throws(
    () => assertToolContinuationClaim(f.request, { ...next, leaseOwner: randomUUID() }),
    /decision_lease_owner/
  );
  assert.throws(() => prepareToolContinuation(f.request), /decision_request_quota_exhausted/);
});
test("numeric IDs are rejected before coercion into issued or completed tool IDs", async () => {
  const f = await fixture();
  const options = {
    ...proof(),
    calls: [{ ...proof().calls[0], id: 123 }],
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  };
  assert.throws(
    () =>
      issueToolContinuation(
        f.identity,
        options as unknown as Parameters<typeof issueToolContinuation>[1]
      ),
    /calls/
  );
  issueToolContinuation(f.identity, {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  assert.throws(
    () =>
      prepareToolContinuation({
        ...f.request,
        completedCallIds: [123],
      } as unknown as ToolContinuationRequest),
    /results/
  );
});
test("terminal metadata commit atomically establishes application success without changing cost", async () => {
  const f = await fixture();
  getDbInstance()
    .prepare("UPDATE decision_application_attempts SET application_status=NULL WHERE id=?")
    .run(f.identity.id);
  const options = {
    ...proof(),
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  };
  assert.throws(() => issueToolContinuation(f.identity, options), /origin_incomplete/);
  commitToolContinuation(f.identity, options);
  assert.equal(readDecisionAttempts(f.identity.keyId)[0].application_status, 200);
  assert.equal(readDecisionAttempts(f.identity.keyId)[0].cost_usd, null);
  assert.equal(readToolContinuations(f.identity.keyId, f.identity.comboId).length, 1);
  assert.equal(getKeyQuotaStatus(f.identity.keyId).counters.rpmUsed, 1);
});
test("metadata write failure rolls back client success and pin, preserving physical usage and cost", async () => {
  const f = await fixture();
  settleDecisionAttempt(f.identity, { status: 200, input: 2, output: 3, cost: 0.02 });
  getDbInstance()
    .prepare("UPDATE decision_application_attempts SET application_status=NULL WHERE id=?")
    .run(f.identity.id);
  getDbInstance().exec(
    "CREATE TEMP TRIGGER fail_terminal_pin BEFORE INSERT ON decision_tool_calls BEGIN SELECT RAISE(ABORT,'synthetic metadata fault'); END"
  );
  try {
    assert.throws(() =>
      commitToolContinuation(f.identity, {
        ...proof(),
        expectedPolicy: f.expectedPolicy,
        expectedAuthority: f.expectedAuthority,
      })
    );
  } finally {
    getDbInstance().exec("DROP TRIGGER fail_terminal_pin");
  }
  const row = readDecisionAttempts(f.identity.keyId)[0];
  assert.equal(row.application_status, null);
  assert.equal(row.state, "completed");
  assert.equal(row.input_tokens, 2);
  assert.equal(row.output_tokens, 3);
  assert.equal(row.cost_usd, 0.02);
  assert.equal(readToolContinuations(f.identity.keyId, f.identity.comboId).length, 0);
  assert.equal(getKeyQuotaStatus(f.identity.keyId).counters.rpmUsed, 1);
});
test("failed application and forged owner cannot commit a terminal pin", async () => {
  for (const forged of [false, true]) {
    const f = await fixture();
    if (!forged) finishDecisionApplication(f.identity.id, 499);
    assert.throws(() =>
      commitToolContinuation(forged ? { ...f.identity, leaseOwner: randomUUID() } : f.identity, {
        ...proof(),
        expectedPolicy: f.expectedPolicy,
        expectedAuthority: f.expectedAuthority,
      })
    );
    assert.equal(readToolContinuations(f.identity.keyId, f.identity.comboId).length, 0);
  }
});
function completeSynthetic(identity: AttemptIdentity): void {
  reserveDecisionAttempt(identity);
  startDecisionAttempt(identity);
  settleDecisionAttempt(identity, { status: 200, input: 2, output: 3, cost: null });
  finishDecisionApplication(identity.id, 200);
}
test("exactly32 live groups per key+combo are allowed and the next publishes no metadata", async () => {
  const f = await fixture();
  for (let index = 0; index <= TOOL_CONTINUATION_LIMITS.live; index++) {
    const origin = index === 0 ? f.identity : fresh(f.identity);
    if (index > 0) completeSynthetic(origin);
    const group = {
      ...proof(),
      clientPrefixJSON: JSON.stringify([
        { role: "user", content: "synthetic-session-" + index },
        JSON.parse(prefix)[1],
      ]),
    };
    const options = {
      ...group,
      expectedPolicy: f.expectedPolicy,
      expectedAuthority: decisionAuthorityStamp(origin, f.expectedPolicy),
    };
    if (index === TOOL_CONTINUATION_LIMITS.live)
      assert.throws(() => issueToolContinuation(origin, options), /live_limit/);
    else issueToolContinuation(origin, options);
  }
  assert.equal(readToolContinuations(f.identity.keyId, f.identity.comboId).length, 32);
  assert.equal(readDecisionAttempts(f.identity.keyId).length, 33);
});
test("a persisted32-group ancestry preserves repeated IDs and cannot issue depth33", async () => {
  const f = await fixture();
  let origin = f.identity,
    group = proof();
  let turnId = issueToolContinuation(origin, {
    ...group,
    expectedPolicy: f.expectedPolicy,
    expectedAuthority: f.expectedAuthority,
  });
  const history = [group];
  for (let depth = 1; depth <= TOOL_CONTINUATION_LIMITS.depth; depth++) {
    const next = fresh(origin);
    claimToolContinuation({ ...f.request, history }, next);
    startDecisionAttempt(next);
    settleDecisionAttempt(next, { status: 200, input: 2, output: 3, cost: null });
    finishDecisionApplication(next.id, 200);
    group = {
      ...proof(),
      clientPrefixJSON: JSON.stringify([
        ...JSON.parse(group.clientPrefixJSON),
        { role: "tool", tool_call_id: "fixture_call", content: "Synthetic result" },
        JSON.parse(prefix)[1],
      ]),
    };
    const options = {
      ...group,
      expectedPolicy: f.expectedPolicy,
      expectedAuthority: decisionAuthorityStamp(next, f.expectedPolicy),
      previousTurnId: turnId,
    };
    if (depth === TOOL_CONTINUATION_LIMITS.depth) {
      assert.throws(() => issueToolContinuation(next, options), /depth/);
      break;
    }
    turnId = issueToolContinuation(next, options);
    history.push(group);
    origin = next;
  }
  const rows = readToolContinuations(f.identity.keyId, f.identity.comboId);
  assert.equal(rows.length, 32);
  assert.equal(Math.max(...rows.map((row) => Number(row.depth))), 31);
});
test("end-turn consumption and client success commit atomically, or both roll back", async () => {
  for (const fault of [false, true]) {
    const f = await fixture();
    const id = issueToolContinuation(f.identity, {
      ...proof(),
      expectedPolicy: f.expectedPolicy,
      expectedAuthority: f.expectedAuthority,
    });
    const next = fresh(f.identity);
    claimToolContinuation(f.request, next);
    startDecisionAttempt(next);
    settleDecisionAttempt(next, { status: 200, input: 2, output: 3, cost: null });
    if (fault)
      getDbInstance().exec(
        "CREATE TEMP TRIGGER fail_terminal_end BEFORE UPDATE ON decision_tool_turns BEGIN SELECT RAISE(ABORT,'synthetic end fault'); END"
      );
    try {
      if (fault) assert.throws(() => commitToolContinuationEnd(id, next));
      else commitToolContinuationEnd(id, next);
    } finally {
      if (fault) getDbInstance().exec("DROP TRIGGER fail_terminal_end");
    }
    const turn = readToolContinuations(next.keyId, next.comboId)[0];
    const receipt = readDecisionAttempts(next.keyId).find((row) => row.id === next.id)!;
    assert.equal(turn.state, fault ? "claimed" : "consumed");
    assert.equal(receipt.application_status, fault ? null : 200);
    assert.equal(receipt.cost_usd, null);
    if (!fault)
      assert.throws(
        () =>
          issueToolContinuation(next, {
            ...proof(),
            expectedPolicy: f.expectedPolicy,
            expectedAuthority: decisionAuthorityStamp(next, f.expectedPolicy),
            previousTurnId: id,
          }),
        /previous/
      );
  }
});
