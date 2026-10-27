/** Local lexical/structural heuristic, not a learned score or correctness prediction.
 * Assessments expose fixed metadata only. The instruction helper is for local extraction. */
export const TASK_DIFFICULTY_LEVELS = [
  "easy",
  "moderate",
  "difficult",
  "critical",
  "unknown",
] as const;
export type TaskDifficulty = (typeof TASK_DIFFICULTY_LEVELS)[number];
export const MAX_DIFFICULTY_TEXT_CHARS = 16_384;
const LIMIT = 8;
type Signals = {
  operations: number;
  constraints: number;
  systems: number;
  algorithms: number;
  proofObligations: number;
  failureModes: number;
  deliverables: number;
  listedSteps: number;
  codeBlocks: number;
  codeFunctions: number;
  codeLoops: number;
  codeBranches: number;
  codeNesting: number;
  crossSystemDependency: boolean;
  irreversibleAction: boolean;
  highStakes: boolean;
  routingDirectiveIgnored: boolean;
  quotedMaterialOmitted: boolean;
  continuation: boolean;
};
export type TaskDifficultyAssessment = {
  version: "local-structure-v1";
  difficulty: TaskDifficulty;
  signals: Signals;
  reasons: Array<
    | "input_unavailable"
    | "input_bound_exceeded"
    | "incomplete_quoted_material"
    | "insufficient_task_evidence"
    | "reference_only_continuation"
    | "atomic_task"
    | "bounded_multistep_task"
    | "coupled_constraints"
    | "algorithmic_obligations"
    | "failure_interactions"
    | "code_structure"
    | "irreversible_high_stakes_task"
    | "routing_directive_ignored"
    | "local_heuristic_only"
  >;
};
type Reason = TaskDifficultyAssessment["reasons"][number];
const OPERATIONS = [
  /\b(?:explain|describe|summarize|translate|rephrase|define)\b/i,
  /\b(?:extract|format|rename|convert|correct)\b/i,
  /\b(?:implement|write|build|create|add|fix|debug|refactor)\b/i,
  /\b(?:compare|analyze|evaluate|diagnose|investigate|review)\b/i,
  /\b(?:test|verify|validate|prove|derive|demonstrate)\b/i,
  /\b(?:migrate|coordinate|reconcile|synchronize|integrate)\b/i,
  /\b(?:sort|filter|deduplicate|group|join|schedule|optimize)\b/i,
  /\b(?:deploy|delete|restore|revoke|transfer|cutover|recover)\b/i,
];
const CONSTRAINTS = [
  /\b(?:must|shall|required|ensure)\b/i,
  /\b(?:without|never|cannot|do not|no duplicates|no data loss)\b/i,
  /\b(?:at most|at least|exactly|within)\b|\bO\([^\n)]{1,40}\)/i,
  /\b(?:preserve|retain|unchanged|backwards.compatib\w*)\b/i,
  /\b(?:if|unless|except|only when|provided that)\b/i,
  /\b(?:atomic|idempotent|exactly.once|linearizable|serializable)\b/i,
  /\b(?:memory|latency|deadline|throughput|space complexity|time complexity)\b/i,
  /\b(?:all|every)\s+(?:case|input|state|worker|request|transition)s?\b/i,
];
const SYSTEMS = [
  /\b(?:database|sql|postgres(?:ql)?|mysql|sqlite|ledger)\b/i,
  /\b(?:queue|kafka|rabbitmq|broker|event bus)\b/i,
  /\b(?:api|endpoint|http|gateway)\b/i,
  /\b(?:cache|redis|memcache)\b/i,
  /\b(?:worker|scheduler|job runner)\b/i,
  /\b(?:browser|frontend|client)\b/i,
  /\b(?:filesystem|file system|disk|object storage|s3)\b/i,
  /\b(?:service|server|backend|replica)\b/i,
];
const ALGORITHMS = [
  /\b(?:graph|shortest path|topological|cycle detection)\b/i,
  /\b(?:dynamic programming|recurrence|backtracking|branch.and.bound)\b/i,
  /\b(?:sort|search|index|partition|hash|deduplicate)\b/i,
  /\b(?:optimi[sz]e|optimal|minimum|maximum|scheduling|schedule)\b/i,
  /\b(?:concurrent|distributed|consensus|transaction|locking)\b/i,
];
const PROOFS = [
  /\b(?:prove|proof|derive|formal)\b/i,
  /\b(?:invariant|correctness|termination|liveness|safety)\b/i,
  /\b(?:complexity|asymptotic|upper bound|lower bound)\b|\bO\([^\n)]{1,40}\)/i,
];
const FAILURES = [
  /\b(?:race|concurrent|concurrency|deadlock)\b/i,
  /\b(?:crash|restart|process death|power loss)\b/i,
  /\b(?:cancel|cancellation|disconnect|timeout)\b/i,
  /\b(?:partial failure|partial completion|network partition|unavailable)\b/i,
  /\b(?:retry|retries|duplicate|double charge|double.charging|double.counting)\b/i,
  /\b(?:out.of.order|stale|late completion|expired owner)\b/i,
  /\b(?:rollback|recovery|recover)\b/i,
];
const DELIVERABLES = [
  /\b(?:code|function|class|module|implementation|program)\b/i,
  /\b(?:test|tests|fixture|regression|benchmark)\b/i,
  /\b(?:schema|migration|database design)\b/i,
  /\b(?:design|architecture|protocol|state machine)\b/i,
  /\b(?:report|explanation|documentation|guide)\b/i,
];
function emptySignals(): Signals {
  return {
    operations: 0,
    constraints: 0,
    systems: 0,
    algorithms: 0,
    proofObligations: 0,
    failureModes: 0,
    deliverables: 0,
    listedSteps: 0,
    codeBlocks: 0,
    codeFunctions: 0,
    codeLoops: 0,
    codeBranches: 0,
    codeNesting: 0,
    crossSystemDependency: false,
    irreversibleAction: false,
    highStakes: false,
    routingDirectiveIgnored: false,
    quotedMaterialOmitted: false,
    continuation: false,
  };
}
function assessment(
  difficulty: TaskDifficulty,
  signals: Signals,
  ...reasons: Reason[]
): TaskDifficultyAssessment {
  if (signals.routingDirectiveIgnored) reasons.push("routing_directive_ignored");
  reasons.push("local_heuristic_only");
  return { version: "local-structure-v1", difficulty, signals, reasons };
}
function distinct(text: string, patterns: readonly RegExp[]): number {
  return Math.min(LIMIT, patterns.filter((pattern) => pattern.test(text)).length);
}
function occurrences(text: string, pattern: RegExp): number {
  return Math.min(LIMIT, Array.from(text.matchAll(pattern)).length);
}
function codeStructure(code: string, signals: Signals): void {
  // This is a bounded lexical scan, not code execution or a validity/parser claim.
  const plain = code
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, " ")
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g, " ");
  signals.codeFunctions = Math.min(
    LIMIT,
    signals.codeFunctions +
      occurrences(
        plain,
        /\b(?:def|function)\s+\w+|\b(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(/g
      )
  );
  signals.codeLoops = Math.min(LIMIT, signals.codeLoops + occurrences(plain, /\b(?:for|while)\b/g));
  signals.codeBranches = Math.min(
    LIMIT,
    signals.codeBranches + occurrences(plain, /\b(?:if|elif|else|switch|case|catch)\b/g)
  );
  let depth = 0;
  for (const character of plain) {
    if (character === "{") depth++;
    if (character === "}") depth = Math.max(0, depth - 1);
    signals.codeNesting = Math.max(signals.codeNesting, Math.min(LIMIT, depth));
  }
}
function routingDirective(sentence: string): boolean {
  return (
    /\b(?:set|mark|label|classify|report|pretend|treat)\s+(?:the\s+)?(?:task\s+)?(?:difficulty|complexity)\b/i.test(
      sentence
    ) ||
    /\b(?:ignore|bypass|override|disable)\b[^.!?\n]{0,100}\b(?:routing|eligibility|policy|instructions|quota|limits)\b/i.test(
      sentence
    ) ||
    /\b(?:route|switch|select|force|use)\b[^.!?\n]{0,70}\b(?:model|effort|highest|cheapest|paid|max|xhigh)\b/i.test(
      sentence
    )
  );
}
function requestText(text: string, signals: Signals, omitRoutingDirectives = true): string | null {
  const chunks = text.split("```");
  if (chunks.length % 2 === 0) return null;
  const prose: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    if (index % 2 === 0) prose.push(chunks[index]);
    else {
      signals.codeBlocks = Math.min(LIMIT, signals.codeBlocks + 1);
      codeStructure(chunks[index], signals);
    }
  }
  const unquoted = prose
    .join(" ")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ")
    .replace(/^\s*>[^\n]*/gm, " ");
  signals.quotedMaterialOmitted = signals.codeBlocks > 0 || unquoted !== prose.join(" ");
  return unquoted
    .split(/(?<=[.!?;])\s+|\n/)
    .filter((sentence) => {
      if (!omitRoutingDirectives || !routingDirective(sentence)) return true;
      signals.routingDirectiveIgnored = true;
      return false;
    })
    .join("\n");
}
function populate(text: string, signals: Signals): void {
  signals.operations = distinct(text, OPERATIONS);
  signals.constraints = distinct(text, CONSTRAINTS);
  signals.systems = distinct(text, SYSTEMS);
  signals.algorithms = distinct(text, ALGORITHMS);
  signals.proofObligations = distinct(text, PROOFS);
  signals.failureModes = distinct(text, FAILURES);
  signals.deliverables = distinct(text, DELIVERABLES);
  signals.listedSteps = occurrences(text, /(?:^|\n)\s*(?:\d{1,2}[.)]|[-*])\s+\S/g);
  signals.crossSystemDependency =
    signals.systems >= 2 &&
    /\b(?:across|between|integrat\w*|synchroniz\w*|coordinat\w*|reconcil\w*|end.to.end)\b/i.test(
      text
    );
  signals.irreversibleAction =
    /\b(?:migrate|deploy|delete|restore|revoke|transfer|cutover)\b/i.test(text);
  signals.highStakes =
    /\b(?:production|payment|payments|financial|ledger|patient|dosage|medical|authentication|authorization|safety.critical|irreversible)\b/i.test(
      text
    );
  signals.continuation =
    /^\s*(?:continue|do (?:it|that)|fix (?:it|that)|same (?:thing|task)|make it better|go ahead)[.!?\s]*$/i.test(
      text
    );
}
function isAtomicTask(signals: Signals, text: string): boolean {
  return (
    signals.operations === 1 &&
    !signals.algorithms &&
    !signals.proofObligations &&
    !signals.failureModes &&
    signals.constraints <= 1 &&
    !signals.codeBranches &&
    /\b(?:explain|describe|summarize|translate|rephrase|define|extract|format|rename|convert|correct)\b/i.test(
      text
    )
  );
}
function structuralReasons(
  coupled: boolean,
  algorithmic: boolean,
  failures: boolean,
  structuredCode: boolean
): Reason[] {
  const reasons: Reason[] = [];
  if (coupled) reasons.push("coupled_constraints");
  if (algorithmic) reasons.push("algorithmic_obligations");
  if (failures) reasons.push("failure_interactions");
  if (structuredCode) reasons.push("code_structure");
  return reasons;
}
function isCriticalTask(signals: Signals, structuralRequirement: boolean): boolean {
  return (
    signals.highStakes &&
    signals.irreversibleAction &&
    signals.constraints >= 2 &&
    structuralRequirement
  );
}
function lacksProofContext(signals: Signals): boolean {
  return Boolean(signals.proofObligations && !signals.algorithms && signals.constraints < 2);
}
function classify(signals: Signals, text: string): TaskDifficultyAssessment {
  if (signals.continuation) return assessment("unknown", signals, "reference_only_continuation");
  if (!signals.operations || text.trim().split(/\s+/).length < 2)
    return assessment("unknown", signals, "insufficient_task_evidence");
  const coupled = signals.crossSystemDependency && signals.constraints >= 2;
  const algorithmic = signals.algorithms >= 1 && signals.proofObligations >= 2;
  const failures = signals.failureModes >= 2 && signals.constraints >= 2;
  const structuredCode = signals.codeLoops >= 2 && signals.codeBranches >= 1;
  if (isCriticalTask(signals, coupled || failures || algorithmic))
    return assessment("critical", signals, "irreversible_high_stakes_task");
  const reasons = structuralReasons(coupled, algorithmic, failures, structuredCode);
  if (reasons.length) return assessment("difficult", signals, ...reasons);
  if (lacksProofContext(signals))
    return assessment("unknown", signals, "insufficient_task_evidence");
  if (isAtomicTask(signals, text)) return assessment("easy", signals, "atomic_task");
  return assessment("moderate", signals, "bounded_multistep_task");
}
/** Local-only task prose; quoted payloads are not the user's instructions.
 * Intent retains ordinary questions about routing/models; difficulty separately filters directives. */
export function taskInstructionText(text: unknown): string | null {
  if (typeof text !== "string" || text.length > MAX_DIFFICULTY_TEXT_CHARS) return null;
  return requestText(text, emptySignals(), false);
}

export function assessTaskDifficulty(text: unknown): TaskDifficultyAssessment {
  const signals = emptySignals();
  if (typeof text !== "string") return assessment("unknown", signals, "input_unavailable");
  if (text.length > MAX_DIFFICULTY_TEXT_CHARS)
    return assessment("unknown", signals, "input_bound_exceeded");
  if (!text.trim()) return assessment("unknown", signals, "input_unavailable");
  const prose = requestText(text, signals);
  if (prose === null) return assessment("unknown", signals, "incomplete_quoted_material");
  populate(prose, signals);
  return classify(signals, prose);
}
