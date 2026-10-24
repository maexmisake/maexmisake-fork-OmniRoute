import {
  readDecisionAttempts,
  decisionAdmissionBlocked,
} from "../../../src/lib/db/decisionAttempts.ts";
import { resetDbInstance } from "../../../src/lib/db/core.ts";
const keyId = process.argv[2];
const rows = readDecisionAttempts(keyId);
const blocked = decisionAdmissionBlocked(keyId);
resetDbInstance();
console.log(
  "DECISION_RECOVERY_EVIDENCE " + JSON.stringify({ states: rows.map((row) => row.state), blocked })
);
process.exit(0);
