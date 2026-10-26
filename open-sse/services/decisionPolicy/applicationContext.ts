import { AsyncLocalStorage } from "node:async_hooks";
import type { StrictValidationDispatch } from "../../executors/base/validationDispatch.ts";

export type ApplicationToolHooks = {
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
  signal: AbortSignal;
  /** Private prepared-provider contract; never accepted from request data. */
  executionContract?: "agy-gemini-high-v1";
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
  };
  observe: (send: Promise<Response>) => Promise<Response>;
};
const attempts = new AsyncLocalStorage<ApplicationAttempt>();
export const currentApplicationAttempt = () => attempts.getStore();
/** Keep the audited AGY account namespace when the ordinary alias resolver names its executor. */
export function applicationProviderIdentity(
  provider: string,
  model: unknown,
  requestedModel: string,
  combo: unknown
): string {
  const attempt = currentApplicationAttempt();
  return attempt?.executionContract === "agy-gemini-high-v1" &&
    attempt.provider === "agy" &&
    attempt.model === "gemini-3.8-flash-high" &&
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
