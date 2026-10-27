import { AsyncLocalStorage } from "node:async_hooks";
import type { StrictValidationDispatch } from "../../executors/base/validationDispatch.ts";

export type ApplicationToolHooks = {
  /** Private native Responses replay projection, bound to the prepared tool turn. */
  codexRequest?: (
    model: string,
    body: Record<string, unknown>,
    stream: boolean,
    credentials: Record<string, unknown> | null
  ) => Record<string, unknown>;
  /** Exact private native request hook; runs before legacy signature/cache translation. */
  geminiRequest?: (
    model: string,
    body: Record<string, unknown>,
    stream: boolean,
    credentials: Record<string, unknown> | null
  ) => Record<string, unknown>;
  /** Private native projection; never reads or writes the ordinary signature cache. */
  geminiResponse?: (chunk: unknown) => Record<string, unknown>[];
  beforeFetch: (wire: Record<string, unknown>) => unknown;
  restoreThinking: (
    message: unknown,
    originalIndex: number
  ) => import("../claudeThinkingStore.ts").ClaudeSignedThinkingBlock[];
  preserveWireThinking: (message: unknown, messages: readonly unknown[], index: number) => boolean;
  rawEvent: (event: Record<string, unknown>) => void;
  rawComplete: () => void;
  clientFrame: (payload: unknown, done: boolean) => boolean;
  validateClientComplete: (status: number) => void;
  commitClientComplete: () => void;
};
export type ApplicationAttempt = {
  id: string;
  keyId: string;
  provider: string;
  model: string;
  connectionId: string;
  effort: string;
  lane?: "decision" | "execution";
  requestId?: string;
  parentAttemptId?: string;
  /** Trusted observation of a complete upstream rejection, never accepted from headers. */
  rejection?: () => import("./retryPolicy.ts").CompletedExecutionRejection | null;
  signal: AbortSignal;
  /** Private prepared-provider contract; never accepted from request data. */
  executionContract?:
    "agy-gemini-high-v1" | "agy-opus-fixed-native-output-v1" | "codex-native-output-v1";
  /** Trusted operator context allowance, never a provider-enforced generation ceiling. */
  nativeOutput?: { contextOutputTokens: number };
  /** Private strict Responses ingress has already been projected to canonical Chat. */
  canonicalChat?: boolean;
  tools?: ApplicationToolHooks;
  /** Release occupancy without asserting that a started remote call stopped. */
  release?: () => void;
  dispatch: StrictValidationDispatch;
  assertIdle: () => void;
  assertFresh: () => void;
  fence: (executor: unknown) => unknown;
  stream?: {
    readonly active: boolean;
    readonly includeUsage: boolean;
    wrap: (response: Response) => Response;
    reportedClientUsage: () => Record<string, unknown> | null;
    noteClientOutcome: (status: number) => void;
    onClientCompletion: (commit: (commitTools: () => void) => void, release: () => void) => void;
  };
  observe: (send: Promise<Response>) => Promise<Response>;
};
const attempts = new AsyncLocalStorage<ApplicationAttempt>();
export const currentApplicationAttempt = () => attempts.getStore();
const agyContractModels: Readonly<Record<string, string>> = {
  "agy-gemini-high-v1": "gemini-3.8-flash-high",
  "agy-opus-fixed-native-output-v1": "claude-opus-4-6-thinking",
};
export function isAgyApplicationContract(contract: string | undefined): boolean {
  return !!contract && Object.hasOwn(agyContractModels, contract);
}
/** Keep the audited AGY account namespace when the ordinary alias resolver names its executor. */
export function applicationProviderIdentity(
  provider: string,
  model: unknown,
  requestedModel: string,
  combo: unknown
): string {
  const attempt = currentApplicationAttempt();
  return isAgyApplicationContract(attempt?.executionContract) &&
    attempt !== undefined &&
    attempt.provider === "agy" &&
    agyContractModels[attempt.executionContract!] === attempt.model &&
    attempt.effort === "high" &&
    provider === "antigravity" &&
    model === attempt.model &&
    requestedModel === `agy/${attempt.model}` &&
    !combo
    ? "agy"
    : provider;
}
export function isBoundedClaudeMaxEffort(
  provider: string | undefined,
  model: string | undefined,
  requestedEffort: unknown
): boolean {
  const attempt = currentApplicationAttempt();
  return (
    provider === "claude" &&
    (model === "claude-sonnet-5-5" || model === "claude-haiku-5-5") &&
    requestedEffort === "max" &&
    attempt?.provider === provider &&
    attempt.model === model &&
    attempt.effort === requestedEffort
  );
}
export function withApplicationAttempt<T>(attempt: ApplicationAttempt, run: () => T): T {
  return attempts.run(attempt, run);
}
