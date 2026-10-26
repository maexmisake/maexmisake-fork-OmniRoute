import { AsyncLocalStorage } from "node:async_hooks";
import type { StrictValidationDispatch } from "../../executors/base/validationDispatch.ts";

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
