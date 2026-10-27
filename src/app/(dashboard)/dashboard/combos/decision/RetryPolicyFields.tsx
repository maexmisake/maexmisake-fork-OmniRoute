"use client";

import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import type { Draft } from "./decisionRoutingDraft";

export default function RetryPolicyFields({
  draft,
  disabled,
  update,
}: {
  draft: Draft;
  disabled: boolean;
  update: (patch: Partial<Draft>) => void;
}) {
  return (
    <Card title="Configured execution failover">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="Enable configured execution failover"
          checked={draft.retryEnabled}
          disabled={disabled}
          onChange={(event) =>
            update({
              retryEnabled: event.target.checked,
              maxExecutionAttempts:
                draft.maxExecutionAttempts === "1" ? "2" : draft.maxExecutionAttempts,
            })
          }
        />
        Allow only the directed alternatives and failure scopes configured below.
      </label>
      <p className="mt-3 text-sm text-text-muted">
        Disabled by default. A completed rejection may use an explicitly configured eligible
        profile. Unknown completion, partial output, access denial and pinned tool continuations
        stop. Each physical attempt has a receipt; missing cost stays unknown. All attempts share
        one deadline.
      </p>
      {draft.retryEnabled && (
        <div className="mt-4 space-y-3">
          <Input
            label="Maximum execution attempts"
            type="number"
            min={2}
            max={5}
            value={draft.maxExecutionAttempts}
            disabled={disabled}
            onChange={(event) => update({ maxExecutionAttempts: event.target.value })}
          />
          <label className="block text-sm">
            Directed failover transitions (JSON array)
            <textarea
              aria-label="Directed failover transitions (JSON array)"
              value={draft.retryTransitions}
              disabled={disabled}
              onChange={(event) => update({ retryTransitions: event.target.value })}
              className="mt-2 min-h-32 w-full rounded-control border border-border bg-bg p-3 font-mono text-sm text-text-main"
            />
          </label>
          <p className="text-xs text-text-muted">
            Each row has from and to profile IDs and a scopes array. Supported scopes:
            account-quota, account-rate-limit, model-unavailable, provider-unavailable. Account
            scopes require a different connection; provider availability requires a different
            provider. Profile and effort eligibility still applies. There is no automatic
            decision-provider fallback.
          </p>
        </div>
      )}
    </Card>
  );
}
