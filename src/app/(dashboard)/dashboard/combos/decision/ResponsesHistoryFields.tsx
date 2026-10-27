"use client";
import Input from "@/shared/components/Input";
import type { Draft } from "./decisionRoutingDraft";

export default function ResponsesHistoryFields({
  draft,
  disabled,
  update,
}: {
  draft: Draft;
  disabled: boolean;
  update: (patch: Partial<Draft>) => void;
}) {
  return (
    <fieldset
      className="mt-4 space-y-3 border-t border-border pt-4"
      disabled={disabled || !draft.sessionsEnabled}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="Enable encrypted Responses history"
          checked={draft.responsesEnabled}
          onChange={(event) =>
            update({ responsesEnabled: event.target.checked, responsesAcknowledged: false })
          }
        />
        Enable encrypted Responses history for clients requesting previous_response_id continuation.
      </label>
      <p className="text-sm text-text-muted">
        Off by default. The client must also send store: true. Existing storage encryption is
        required; clients with no-log enabled cannot retain or resume transcripts. Sequential reuse
        is a new request that may incur charges, not an idempotent replay. Instructions apply to the
        current turn only.
      </p>
      {draft.responsesEnabled && (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="I acknowledge storage of encrypted task and response transcripts"
              checked={draft.responsesAcknowledged}
              onChange={(event) => update({ responsesAcknowledged: event.target.checked })}
            />
            I acknowledge storage of encrypted task and response transcripts, separate from routing
            metadata.
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <Input
              label="Responses history lifetime (ms)"
              type="number"
              min={1000}
              max={1800000}
              value={draft.responseTtlMs}
              onChange={(event) => update({ responseTtlMs: event.target.value })}
            />
            <Input
              label="Maximum stored Responses per client and combo"
              type="number"
              min={1}
              max={32}
              value={draft.responseMaxStored}
              onChange={(event) => update({ responseMaxStored: event.target.value })}
            />
          </div>
        </>
      )}
    </fieldset>
  );
}
