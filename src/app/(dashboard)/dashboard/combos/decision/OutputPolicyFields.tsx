"use client";

import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import type { Draft } from "./decisionRoutingDraft";

type Props = {
  draft: Draft;
  disabled: boolean;
  update: (patch: Partial<Draft>) => void;
};

export default function OutputPolicyFields({ draft, disabled, update }: Props) {
  const native = draft.applicationMode === "provider-native-output-v1";
  return (
    <Card title="Execution output policy">
      <Select
        label="Execution output policy"
        value={draft.applicationMode}
        disabled={disabled}
        onChange={(event) =>
          update({
            applicationMode: event.target.value as Draft["applicationMode"],
            nativeOutputAcknowledged: false,
            contextOutputTokens: "",
          })
        }
      >
        <option value="bounded-v1">Bounded output — explicit caller token cap required</option>
        <option value="provider-native-output-v1">
          Provider-native output — no provider-enforced token ceiling
        </option>
      </Select>
      {native ? (
        <div className="mt-4 space-y-4">
          <p id="native-output-disclosure" role="note" className="text-sm text-text-muted">
            This separate opt-in permits provider-native generation length for the exact supported
            Codex and fixed-thinking AGY Opus profiles. No provider-enforced output-token ceiling is
            promised. Caller max_tokens or max_completion_tokens is rejected, never silently
            dropped. Only streaming requests are supported. Flat function tools require an
            explicitly tool-capable supported profile; continuations retain their authenticated
            original pair. Unsupported schemas, images and provider built-in tools still reject.
            Financially or token-capped client keys remain unsupported. A timeout or a clipped
            stream does not limit tokens already generated remotely. Missing usage or cost remains
            unknown; this mode is not a spending cap.
          </p>
          <Input
            label="Output context-planning allowance (tokens)"
            type="number"
            min={1}
            max={1000000}
            step={1}
            value={draft.contextOutputTokens}
            disabled={disabled}
            onChange={(event) => update({ contextOutputTokens: event.target.value })}
          />
          <p className="text-xs text-text-muted">
            Enter an operator-chosen allowance for context eligibility. Providers that require a
            finite output maximum use it as their request limit; it is not a hard maximum for Codex
            or the fixed-thinking Opus native-output contract. No allowance is selected for you.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.nativeOutputAcknowledged}
              disabled={disabled}
              aria-describedby="native-output-disclosure"
              onChange={(event) => update({ nativeOutputAcknowledged: event.target.checked })}
            />
            <span>
              I acknowledge that provider-native output has no provider-enforced token ceiling
            </span>
          </label>
          <p className="text-xs text-text-muted">
            AGY Opus High retains the original fixed profile designation; an adjustable vendor High
            tier is unverified. Saving this policy does not test access, run inference or establish
            live compatibility. Exact credentials, eligibility and authorization are rechecked at
            dispatch; no paid fallback is added.
          </p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-text-muted">
          Existing bounded behavior stays selected unless you deliberately choose the separate
          provider-native policy. Codex and fixed-thinking AGY Opus remain excluded from bounded
          output. Switching policies never activates routing or replaces the configured profiles.
        </p>
      )}
    </Card>
  );
}
