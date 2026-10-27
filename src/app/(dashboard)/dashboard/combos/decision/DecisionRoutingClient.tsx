"use client";

import Link from "next/link";
import { useState } from "react";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import Toggle from "@/shared/components/Toggle";
import {
  bindingKey,
  eligibleSelector,
  selectedBinding,
  validateDraft,
  type Connection,
  type Draft,
  type EditorOptions,
} from "./decisionRoutingDraft";
import { useDecisionRoutingEditor } from "./useDecisionRoutingEditor";

import ProfileFields from "./ProfileFields";
import DecisionAttemptsPanel from "./DecisionAttemptsPanel";
import OutputPolicyFields from "./OutputPolicyFields";
import DecisionContextFields from "./DecisionContextFields";
import RetryPolicyFields from "./RetryPolicyFields";
import SessionPolicyFields from "./SessionPolicyFields";

function NativeFields({
  draft,
  options,
  disabled,
  update,
}: {
  draft: Draft;
  options: EditorOptions;
  disabled: boolean;
  update: (patch: Partial<Draft>) => void;
}) {
  const binding = selectedBinding(draft, options);
  const connections = options.connections.filter((row) => row.provider === binding?.provider);
  const connection = connections.find((row) => row.id === draft.selectorConnection);
  return (
    <Card title="Native decision selector">
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label="Decision provider and exact model"
          value={draft.binding}
          onChange={(event) =>
            update({
              binding: event.target.value,
              selectorConnection: "",
              decisionContextAcknowledged: false,
              guidanceAcknowledged: false,
            })
          }
          disabled={disabled}
        >
          <option value="">Choose a decision binding</option>
          {options.bindings.map((row) => (
            <option key={bindingKey(row)} value={bindingKey(row)}>
              {row.label} — {row.tier === "free" ? "free-listed" : "paid"}
            </option>
          ))}
        </Select>
        <Select
          label="Decision connection"
          value={draft.selectorConnection}
          onChange={(event) =>
            update({
              selectorConnection: event.target.value,
              decisionContextAcknowledged: false,
              guidanceAcknowledged: false,
            })
          }
          disabled={disabled || !binding}
        >
          <option value="">Choose an explicit connection</option>
          {connections.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label}
              {row.freeTier ? " — free routing guard" : " — paid routing guard"}
            </option>
          ))}
        </Select>
        <Input
          label="Decision timeout (ms)"
          type="number"
          min={1}
          max={10000}
          value={draft.decisionTimeout}
          onChange={(event) => update({ decisionTimeout: event.target.value })}
          disabled={disabled}
        />
        <Input
          label="Maximum decision candidates"
          type="number"
          min={2}
          max={255}
          value={draft.maxCandidates}
          onChange={(event) => update({ maxCandidates: event.target.value })}
          disabled={disabled}
        />
      </div>
      <DecisionContextFields draft={draft} disabled={disabled} update={update} />
      <p className="mt-4 text-sm text-text-muted">
        Native selection uses Choice. Listed protocol support does not establish account access,
        remaining quota or live compatibility. Free Jev is a separate exact binding; no paid
        fallback or account rotation occurs. Provider confidence is not measured correctness.
      </p>
      {binding && connection && !eligibleSelector(connection, binding) && (
        <p role="alert" className="mt-3 text-sm text-red-500">
          This connection cannot currently activate the selected binding. Its active/credential/tier
          and routing metadata must match; unsupported metadata is preserved, never stripped here.
        </p>
      )}
    </Card>
  );
}

function ConnectionTierSettings({
  connections,
  disabled,
  setTier,
}: {
  connections: Connection[];
  disabled: boolean;
  setTier: (connection: Connection, tier: "free" | "paid") => unknown;
}) {
  const [selected, setSelected] = useState("");
  const zen = connections.filter((entry) => entry.provider === "opencode-zen");
  const connection = zen.find((entry) => entry.id === selected);
  return (
    <Card title="OpenCode Zen connection routing guard">
      <p className="mb-3 text-sm text-text-muted">
        This guard is an OmniRoute setting, not provider entitlement. Choose a connection and save
        its guard explicitly before editing a policy. This changes the connection for other combos
        too and may make an existing selector unavailable. Unsupported metadata is preserved; it
        cannot be stripped here to force activation.
      </p>
      <p className="mb-3 text-sm text-text-muted">
        Reload these options after editing a connection in provider settings. Those editors can
        still change its metadata while this screen is open. Routing rechecks a changed tier before
        dispatch and stops instead of switching to a paid fallback.
      </p>
      <Select
        label="Zen connection guard"
        value={selected}
        disabled={disabled}
        onChange={(event) => setSelected(event.target.value)}
      >
        <option value="">Choose a Zen connection</option>
        {zen.map((row) => (
          <option key={row.id} value={row.id}>
            {row.label}
          </option>
        ))}
      </Select>
      {connection && (
        <>
          <p className="mt-2 text-sm">
            Current routing guard: {connection.freeTier ? "free" : "paid"}.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || connection.freeTier}
              onClick={() => void setTier(connection, "free")}
            >
              Set free routing guard
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !connection.freeTier}
              onClick={() => void setTier(connection, "paid")}
            >
              Set paid routing guard
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

export default function DecisionRoutingClient() {
  const editor = useDecisionRoutingEditor();
  const { draft, options } = editor;
  const validation = draft ? validateDraft(draft, options) : null;
  const disabled = editor.busy || editor.mustReload;
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <header>
        <Link href="/dashboard/combos" className="text-sm text-primary underline">
          Back to combos
        </Link>
        <h1 className="mt-3 text-2xl font-semibold">Decision routing settings</h1>
        <p className="mt-2 text-sm text-text-muted">
          Configure an existing combo without calling a model. This opt-in is separate from ordinary
          combo strategies. Saving changes settings only; live access and model-selection quality
          remain unverified.
        </p>
      </header>
      <Card title="Choose a combo">
        <Select
          label="Combo"
          value={editor.comboId}
          disabled={disabled || editor.dirty}
          onChange={(event) => editor.chooseCombo(event.target.value)}
        >
          <option value="">Choose an existing combo</option>
          {options.combos.map((combo) => (
            <option key={combo.id} value={combo.id}>
              {combo.name}
            </option>
          ))}
        </Select>
        {editor.dirty && (
          <p className="mt-2 text-sm">Save or discard changes before switching combos.</p>
        )}
        <Button
          variant="outline"
          className="mt-3"
          disabled={editor.busy}
          onClick={editor.reloadSaved}
        >
          Reload saved settings
        </Button>
      </Card>
      {editor.error && (
        <p role="alert" className="text-sm text-red-500">
          {editor.error}
        </p>
      )}
      {editor.notice && (
        <p role="status" className="text-sm">
          {editor.notice}
        </p>
      )}
      {editor.busy && (
        <p role="status" className="text-sm">
          {editor.pending ? "Saving settings…" : "Loading settings…"}
        </p>
      )}
      {draft && (
        <>
          {editor.saved?.status === "invalid" && (
            <p role="alert" className="text-sm text-red-500">
              Stored policy is invalid and has not been echoed into this editor. Replace it
              deliberately or disable saved routing. Saving a new draft replaces only this policy.
            </p>
          )}
          <Card title="Routing mode">
            <Toggle
              label="Enable decision routing for this combo"
              checked={draft.enabled}
              disabled={disabled}
              onChange={(enabled) => editor.updateDraft({ enabled })}
            />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Select
                label="Selection mode"
                value={draft.mode}
                disabled={disabled}
                onChange={(event) =>
                  editor.updateDraft({ mode: event.target.value as Draft["mode"] })
                }
              >
                <option value="deterministic">Deterministic preference order</option>
                <option value="native">Native decision model</option>
              </Select>
              <Input
                label="Overall request timeout (ms)"
                type="number"
                min={1}
                max={30000}
                value={draft.timeout}
                disabled={disabled}
                onChange={(event) => editor.updateDraft({ timeout: event.target.value })}
              />
              <Select
                label="Unknown quota policy"
                value={draft.unknownQuota}
                disabled={disabled}
                onChange={(event) =>
                  editor.updateDraft({ unknownQuota: event.target.value as Draft["unknownQuota"] })
                }
              >
                <option value="reject">Reject unknown quota</option>
                <option value="allow">Allow unknown quota explicitly</option>
              </Select>
            </div>
            <p className="mt-3 text-sm text-text-muted">
              At most one native decision. Execution uses one exact target unless scoped failover is
              explicitly configured. Decision errors, refusal and cancellation stop routing.
              Enabling requires an authenticated client and compatible application settings.
            </p>
          </Card>
          <OutputPolicyFields draft={draft} disabled={disabled} update={editor.updateDraft} />
          <RetryPolicyFields draft={draft} disabled={disabled} update={editor.updateDraft} />
          <SessionPolicyFields draft={draft} disabled={disabled} update={editor.updateDraft} />
          {draft.mode === "native" && (
            <NativeFields
              draft={draft}
              options={options}
              disabled={disabled}
              update={editor.updateDraft}
            />
          )}
          <ProfileFields
            draft={draft}
            options={options}
            disabled={disabled}
            update={editor.updateDraft}
          />
          {validation && validation.issues.length > 0 && (
            <div role="alert" className="rounded-control border border-red-500/30 p-3 text-sm">
              <p className="font-medium">Settings need attention before saving:</p>
              <ul className="mt-2 list-inside list-disc">
                {validation.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={disabled || !validation?.policy}
              onClick={() => {
                if (validation?.policy) void editor.save(validation.policy);
              }}
            >
              Save settings
            </Button>
            <Button variant="outline" disabled={disabled || !editor.dirty} onClick={editor.discard}>
              Discard changes
            </Button>
            <Button
              variant="danger"
              disabled={disabled || editor.saved?.status === "disabled"}
              onClick={() => void editor.disable()}
            >
              Disable saved routing
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            Inputs are locked while a save is pending. Closing this page cannot undo a completed
            write. An unconfirmed response requires reloading saved settings before further edits.
            No automatic test, discovery or inference runs on this page.
          </p>
          <DecisionAttemptsPanel key={editor.comboId} comboId={editor.comboId} />
          <ConnectionTierSettings
            connections={options.connections}
            disabled={disabled || editor.dirty}
            setTier={editor.setTier}
          />
        </>
      )}
    </div>
  );
}
