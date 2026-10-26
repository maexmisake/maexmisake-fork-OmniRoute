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
  observe: (send: Promise<Response>) => Promise<Response>;
};
const attempts = new AsyncLocalStorage<ApplicationAttempt>();
export const currentApplicationAttempt = () => attempts.getStore();
export function withApplicationAttempt<T>(attempt: ApplicationAttempt, run: () => T): T {
  return attempts.run(attempt, run);
}
