"use client";

import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import type { Draft } from "./decisionRoutingDraft";

export default function DecisionContextFields({
  draft,
  disabled,
  update,
}: {
  draft: Draft;
  disabled: boolean;
  update: (patch: Partial<Draft>) => void;
}) {
  return (
    <fieldset className="mt-4 space-y-3 rounded-control border border-border p-3">
      <legend>Decision task privacy</legend>
      <Select
        label="Decision task context"
        value={draft.decisionContextMode}
        disabled={disabled}
        onChange={(event) =>
          update({
            decisionContextMode: event.target.value as Draft["decisionContextMode"],
            decisionContextAcknowledged: false,
          })
        }
      >
        <option value="local-summary">Local summary only</option>
        <option value="task-text">Latest user task with client consent</option>
      </Select>
      <p className="text-sm text-text-muted">
        The default shares local task labels and counts with the decision provider. It cannot judge
        task details that it has not received. Sharing task text is optional and does not establish
        better selection quality.
      </p>
      {draft.decisionContextMode === "task-text" && (
        <>
          <p className="text-sm text-text-muted">
            The decision provider may receive the exact latest user task, including private content
            in that task. Each client must also consent on its request. System, developer, assistant
            and tool content and earlier user messages are excluded from this decision context.
            Oversized tasks reject before a decision call; no excerpt is silently substituted.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="I acknowledge that consented task text is sent to the decision provider"
              checked={draft.decisionContextAcknowledged}
              disabled={disabled}
              onChange={(event) => update({ decisionContextAcknowledged: event.target.checked })}
            />
            I acknowledge that consented task text is sent to the decision provider
          </label>
          <Input
            label="Maximum shared task characters"
            type="number"
            min={1}
            max={2048}
            value={draft.decisionContextMaxChars}
            disabled={disabled}
            onChange={(event) => update({ decisionContextMaxChars: event.target.value })}
          />
          <p className="text-xs text-text-muted">
            Client consent: send x-omniroute-decision-context: task-text on that request. Without
            it, the decision receives only the local summary. Changing the selected decision binding
            or connection requires a new acknowledgement.
          </p>
        </>
      )}
    </fieldset>
  );
}
