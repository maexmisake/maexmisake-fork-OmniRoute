"use client";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import type { Draft } from "./decisionRoutingDraft";

const controls = [
  ["Session idle timeout (ms)", "sessionIdleTtlMs", 1000, 1800000],
  ["Maximum session turns", "sessionMaxTurns", 1, 256],
  ["Minimum stable turns before task change", "sessionMinStableTurns", 1, 32],
  ["Maximum active sessions per client and combo", "sessionMaxActive", 1, 32],
] as const;
export default function SessionPolicyFields({
  draft,
  disabled,
  update,
}: {
  draft: Draft;
  disabled: boolean;
  update: (patch: Partial<Draft>) => void;
}) {
  return (
    <Card title="Conversation routing stability">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="Enable durable routing sessions"
          checked={draft.sessionsEnabled}
          disabled={disabled}
          onChange={(event) => update({ sessionsEnabled: event.target.checked })}
        />
        Keep the selected account, model and effort for clients requesting a routing session.
      </label>
      <p className="mt-3 text-sm text-text-muted">
        Off by default. Clients request a new session and reuse its opaque identifier with their own
        API key. Only an explicit new-task boundary after the stability threshold permits
        reselection. Explicit effort and current availability still apply; tool continuations retain
        their exact origin. One turn may own a session at a time.
      </p>
      {draft.sessionsEnabled && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {controls.map(([label, field, min, max]) => (
            <Input
              key={field}
              label={label}
              type="number"
              min={min}
              max={max}
              value={draft[field]}
              disabled={disabled}
              onChange={(event) => update({ [field]: event.target.value })}
            />
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-text-muted">
        Routing metadata stores no task text. Idle expiry, policy or credential changes, unavailable
        pins and uncertain interrupted work can require a new session. This does not guarantee
        provider prompt-cache reuse. Streams retain finite proof limits and publish a reusable pin
        only after complete validation.
      </p>
    </Card>
  );
}
