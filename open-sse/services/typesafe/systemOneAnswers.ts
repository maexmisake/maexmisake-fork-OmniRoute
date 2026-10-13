/**
 * System One typed answers and request-envelope validation.
 *
 * System One is not a chat model: a request carries `{ model, state, questions }`
 * and the response answers each question with a typed value — `noul` (yes/no),
 * `choice` (one option) or `score` (a level) — plus the calibrated probability
 * distribution, a confidence and token usage. All of that is the product, so the
 * parser preserves every field it can verify and reports anything else as
 * `invalid_response` rather than guessing.
 *
 * Both halves are pure. Nothing here logs, and no failure message may contain
 * the caller's `state` or `instructions`: the upstream echoes them in some error
 * bodies, and a decision request routinely carries the operator's own data.
 *
 * Reference: the choice-only client in `./systemOne.ts` (#15278) and the
 * TypeSafe API docs (https://docs.typesafe.ai/api).
 */

import { sanitizeErrorMessage } from "../../utils/error.ts";
import { systemOneBackend, type SystemOneLimits } from "../../config/systemOneRegistry.ts";

export const SYSTEMONE_QUESTION_TYPES = ["noul", "choice", "score"] as const;
export type SystemOneQuestionType = (typeof SYSTEMONE_QUESTION_TYPES)[number];

export type SystemOneProbabilities = Record<string, number>;

type AnswerCommon = {
  probabilities: SystemOneProbabilities | null;
  confidence: number | null;
};

export type SystemOneNoulAnswer = AnswerCommon & { type: "noul"; answer: boolean };
export type SystemOneChoiceAnswer = AnswerCommon & { type: "choice"; choice: string };
export type SystemOneScoreAnswer = AnswerCommon & { type: "score"; score: number };
export type SystemOneAnswer = SystemOneNoulAnswer | SystemOneChoiceAnswer | SystemOneScoreAnswer;

export type SystemOneUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Upstream-reported cost in USD. A reported zero is a known zero, not unknown. */
  costUsd: number | null;
};

export type SystemOneAnswersSuccess = {
  ok: true;
  model: string | null;
  answers: Record<string, SystemOneAnswer>;
  usage: SystemOneUsage;
};

export type SystemOneAnswersFailure = {
  ok: false;
  reason: "invalid_response";
  /** Sanitized and free of request state — safe to log or return. */
  detail: string;
};

export type SystemOneAnswersResult = SystemOneAnswersSuccess | SystemOneAnswersFailure;

export type SystemOneValidation = { ok: true } | { ok: false; status: number; message: string };

const OK: SystemOneValidation = { ok: true };

function fail(message: string, status = 400): SystemOneValidation {
  return { ok: false, status, message };
}

function invalid(detail: string): SystemOneAnswersFailure {
  return { ok: false, reason: "invalid_response", detail: sanitizeErrorMessage(detail) || detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A probability map must be numeric and non-negative, or the answer is unusable. */
function parseProbabilities(value: unknown): SystemOneProbabilities | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return "invalid";
  const out: SystemOneProbabilities = {};
  for (const [key, raw] of Object.entries(value)) {
    const probability = finiteNumber(raw);
    if (probability === null || probability < 0) return "invalid";
    out[key] = probability;
  }
  return out;
}

function parseConfidence(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  const confidence = finiteNumber(value);
  if (confidence === null || confidence < 0 || confidence > 1) return "invalid";
  return confidence;
}

function parseAnswer(name: string, raw: unknown): SystemOneAnswer | SystemOneAnswersFailure {
  if (!isRecord(raw)) return invalid(`System One answer ${name} was not an object`);
  const type = raw.type;
  if (
    typeof type !== "string" ||
    !SYSTEMONE_QUESTION_TYPES.includes(type as SystemOneQuestionType)
  ) {
    return invalid(`System One answer ${name} had an unsupported type`);
  }

  const probabilities = parseProbabilities(raw.probabilities);
  if (probabilities === "invalid") {
    return invalid(`System One answer ${name} had invalid probabilities`);
  }
  const confidence = parseConfidence(raw.confidence);
  if (confidence === "invalid") {
    return invalid(`System One answer ${name} had an out-of-range confidence`);
  }
  const common = { probabilities, confidence };

  if (type === "noul") {
    if (typeof raw.answer !== "boolean") {
      return invalid(`System One noul answer ${name} had no boolean answer`);
    }
    return { type, answer: raw.answer, ...common };
  }
  if (type === "choice") {
    const choice = typeof raw.choice === "string" ? raw.choice.trim() : "";
    if (!choice) return invalid(`System One choice answer ${name} had an empty choice`);
    return { type, choice, ...common };
  }
  const score = finiteNumber(raw.score);
  if (score === null) return invalid(`System One score answer ${name} had no numeric score`);
  return { type, score, ...common };
}

function parseUsage(raw: unknown): SystemOneUsage {
  const usage = isRecord(raw) ? raw : null;
  const cost = usage ? finiteNumber(usage.cost) : null;
  return {
    inputTokens: usage ? finiteNumber(usage.input_tokens) : null,
    outputTokens: usage ? finiteNumber(usage.output_tokens) : null,
    costUsd: cost !== null && cost >= 0 ? cost : null,
  };
}

/**
 * Parse a System One response body. Answers of all three question types are
 * preserved with their probabilities, confidence and usage; a body that answers
 * no question at all is a failure, not an empty success.
 */
export function parseSystemOneAnswers(body: unknown): SystemOneAnswersResult {
  if (!isRecord(body)) return invalid("System One response was not a JSON object");
  if (!isRecord(body.answers)) return invalid("System One response missing answers");

  const entries = Object.entries(body.answers);
  if (!entries.length) return invalid("System One response answered no question");

  const answers: Record<string, SystemOneAnswer> = {};
  for (const [name, raw] of entries) {
    const parsed = parseAnswer(name, raw);
    if ("ok" in parsed) return parsed;
    answers[name] = parsed;
  }

  return {
    ok: true,
    model: typeof body.model === "string" ? body.model : null,
    answers,
    usage: parseUsage(body.usage),
  };
}

type Question = Record<string, unknown>;

function validateQuestion(name: string, raw: unknown): SystemOneValidation {
  if (!isRecord(raw)) return fail(`questions.${name} must be an object`);
  const type = raw.type;
  if (
    typeof type !== "string" ||
    !SYSTEMONE_QUESTION_TYPES.includes(type as SystemOneQuestionType)
  ) {
    return fail(`questions.${name}.type must be one of ${SYSTEMONE_QUESTION_TYPES.join(", ")}`);
  }
  if (raw.instructions !== undefined && typeof raw.instructions !== "string") {
    return fail(`questions.${name}.instructions must be a string`);
  }
  if (type === "choice") {
    // Choice criteria are a map of option name → description (description may be null).
    if (!isRecord(raw.criteria) || !Object.keys(raw.criteria).length) {
      return fail(`questions.${name}.criteria must be a non-empty object for a choice question`);
    }
  }
  if (type === "score") {
    // Score criteria are the ordered levels.
    if (!Array.isArray(raw.criteria) || !raw.criteria.length) {
      return fail(`questions.${name}.criteria must be a non-empty array for a score question`);
    }
  }
  return OK;
}

/**
 * Validate the shared request envelope `{ model, state, questions }`.
 *
 * The `state` is never truncated or rewritten here — it is the caller's data and
 * the upstream decides what it accepts. Messages name the offending field only.
 */
export function validateSystemOneRequestBody(body: unknown): SystemOneValidation {
  if (!isRecord(body)) return fail("Request body must be a JSON object");
  if (typeof body.model !== "string" || !body.model.trim()) {
    return fail("model is required");
  }
  if (typeof body.state !== "string") return fail("state must be a string");
  if (!isRecord(body.questions)) return fail("questions must be a non-empty object");
  const entries = Object.entries(body.questions);
  if (!entries.length) return fail("questions must be a non-empty object");
  for (const [name, question] of entries) {
    const validation = validateQuestion(name, question);
    if (!validation.ok) return validation;
  }
  return OK;
}

function candidateCount(question: Question): { kind: SystemOneQuestionType; count: number } | null {
  if (question.type === "choice" && isRecord(question.criteria)) {
    return { kind: "choice", count: Object.keys(question.criteria).length };
  }
  if (question.type === "score" && Array.isArray(question.criteria)) {
    return { kind: "score", count: question.criteria.length };
  }
  return null;
}

function validateLimits(
  provider: string,
  body: Record<string, unknown>,
  limits: SystemOneLimits
): SystemOneValidation {
  const questions = isRecord(body.questions) ? body.questions : {};
  const names = Object.keys(questions);
  if (names.length > limits.maxQuestions) {
    return fail(`questions must contain at most ${limits.maxQuestions} fields for ${provider}`);
  }
  for (const name of names) {
    const question = questions[name];
    if (!isRecord(question)) continue;
    const counted = candidateCount(question);
    if (!counted) continue;
    const max = counted.kind === "choice" ? limits.maxChoiceCriteria : limits.maxScoreLevels;
    if (counted.count < limits.minCriteria || counted.count > max) {
      return fail(
        `questions.${name}.criteria must contain ${limits.minCriteria}–${max} candidates for ${provider}`
      );
    }
  }
  return OK;
}

/**
 * Apply the backend's own request limits on top of the shared envelope. The
 * byte budget is checked last so a small malformed body reports its real
 * problem first.
 */
export function validateSystemOneBackendBody(
  provider: string,
  body: Record<string, unknown>
): SystemOneValidation {
  const { limits } = systemOneBackend(provider);
  const shape = validateLimits(provider, body, limits);
  if (!shape.ok) return shape;
  const bytes = Buffer.byteLength(JSON.stringify(body ?? null), "utf8");
  if (bytes > limits.maxBodyBytes) {
    return fail(`Request body must not exceed ${limits.maxBodyBytes} bytes for ${provider}`, 413);
  }
  return OK;
}
