import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runEnvDocSync, scanCodeVars } from "../../scripts/check/check-env-doc-sync.mjs";

function withSources(sources: Record<string, string>, check: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offline-preload-env-contract-"));
  try {
    for (const [relative, contents] of Object.entries(sources)) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    check(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the offline preload selector is test context, not product configuration", () => {
  withSources(
    {
      "scripts/ad-hoc/native-router-offline-guard.mjs":
        "const mode = process.env.OMNIROUTE_OFFLINE_AUDIT;",
    },
    (cwd) => assert.deepEqual([...scanCodeVars({ cwd })], [])
  );
});

test("other variables in the same preload still require documentation", () => {
  withSources(
    {
      "scripts/ad-hoc/native-router-offline-guard.mjs":
        "process.env.OMNIROUTE_OFFLINE_AUDIT; process.env.NEW_GUARD_SETTING;",
    },
    (cwd) => assert.ok(scanCodeVars({ cwd }).has("NEW_GUARD_SETTING"))
  );
});

test("a production read of the same variable remains a documentation error", () => {
  withSources(
    {
      "scripts/ad-hoc/native-router-offline-guard.mjs": "process.env.OMNIROUTE_OFFLINE_AUDIT;",
      "src/runtime.ts": "process.env.OMNIROUTE_OFFLINE_AUDIT;",
    },
    (cwd) => {
      const result = runEnvDocSync({
        codeVars: scanCodeVars({ cwd }),
        envExampleText: "",
        envDocText: "",
      });
      assert.equal(result.ok, false);
      assert.deepEqual(result.problems.codeMissingEnv, ["OMNIROUTE_OFFLINE_AUDIT"]);
    }
  );
});

test("a same-named preload in another directory receives no exemption", () => {
  withSources(
    { "src/native-router-offline-guard.mjs": "process.env.OMNIROUTE_OFFLINE_AUDIT;" },
    (cwd) => assert.ok(scanCodeVars({ cwd }).has("OMNIROUTE_OFFLINE_AUDIT"))
  );
});
