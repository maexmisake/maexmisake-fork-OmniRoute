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
  type Candidate,
  type Connection,
  type Draft,
  type EditorOptions,
} from "./decisionRoutingDraft";
import { useDecisionRoutingEditor } from "./useDecisionRoutingEditor";

const JSON_CLASS =
  "mt-2 min-h-40 w-full rounded-control border border-border bg-bg p-3 font-mono text-sm text-text-main";

function ProfileFields({
  draft,
  candidates,
  options,
  disabled,
  update,
}: {
  draft: Draft;
  candidates: Candidate[];
  options: EditorOptions;
  disabled: boolean;
  update: (patch: Partial<Draft>) => void;
}) {
  return (
    <Card title="Execution profiles and task preferences">
      <p id="profile-help" className="text-sm text-text-muted">
        This advanced JSON editor requires your own model profiles and task preference orders. Enter
        explicit version 1 profiles with exact provider, model, effort, supported efforts,
        capabilities and evidence. No profiles or rankings are supplied automatically. Unknown
        capability/context evidence stays unknown and cannot authorize a route. Supported execution
        transports are OpenAI API-key text/JSON and Claude OAuth claude-opus-5-5 medium/high.
      </p>
      <label htmlFor="decision-profiles" className="mt-4 block font-medium">
        Candidate profiles (JSON array)
      </label>
      <textarea
        id="decision-profiles"
        aria-describedby="profile-help"
        value={draft.candidates}
        onChange={(event) => update({ candidates: event.target.value })}
        disabled={disabled}
        maxLength={262144}
        spellCheck={false}
        className={JSON_CLASS}
      />
      <p className="mt-2 text-xs text-text-muted">
        Profile fields: id, provider, model, endpointKind, evidence, capabilities
        (text/images/tools/reasoning/contextTokens), effort (mode/value/supported/evidence). Use
        null for unknown evidence; it is not inferred from a model name.
      </p>
      <ul aria-label="Model and effort summary" className="mt-4 space-y-3">
        {candidates.map((candidate) => (
          <li key={candidate.id} className="rounded-control border border-border p-3">
            <p className="mb-2 break-words text-sm">
              {candidate.id}: {candidate.provider}/{candidate.model} · effort:{" "}
              {candidate.effort.value ?? "unknown"}
            </p>
            {(!candidate.evidence || !candidate.effort.evidence) && (
              <p className="mb-2 text-sm text-text-muted">
                Evidence is unknown. Saving this declaration does not prove eligibility; missing
                profile or effort evidence may leave this candidate without a route.
              </p>
            )}
            <Select
              label={`Execution connection for ${candidate.id}`}
              value={draft.connections[candidate.id] ?? ""}
              onChange={(event) =>
                update({
                  connections: { ...draft.connections, [candidate.id]: event.target.value },
                })
              }
              disabled={disabled}
              placeholder="Choose an explicit connection"
            >
              <option value="">Choose an explicit connection</option>
              {options.connections
                .filter((connection) => connection.provider === candidate.provider)
                .map((connection) => (
                  <option
                    key={connection.id}
                    value={connection.id}
                    disabled={!connection.active || !connection.credentialPresent}
                  >
                    {connection.label}
                    {!connection.active ? " — inactive" : ""}
                    {!connection.credentialPresent ? " — credential not configured" : ""}
                  </option>
                ))}
            </Select>
          </li>
        ))}
      </ul>
      <label htmlFor="decision-task-order" className="mt-5 block font-medium">
        Task preference orders (JSON object)
      </label>
      <p id="task-help" className="mt-1 text-sm text-text-muted">
        Map each task category to an ordered array of the candidate IDs you allow. Supported text
        categories include unresolved, explanation, reasoning, complex_code and long_context. An
        omitted category has no route. Order is your preference, not measured model quality.
        Reasoning tasks require explicit reasoning capability and a supported thinking effort.
        Image, tool and continuation requests remain unsupported in this bounded application even if
        their category names appear in an order.
      </p>
      <textarea
        id="decision-task-order"
        aria-describedby="task-help"
        value={draft.taskOrder}
        onChange={(event) => update({ taskOrder: event.target.value })}
        disabled={disabled}
        maxLength={262144}
        spellCheck={false}
        className={JSON_CLASS}
      />
    </Card>
  );
}

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
          onChange={(event) => update({ binding: event.target.value, selectorConnection: "" })}
          disabled={disabled}
        >
          <option value="">Choose a decision binding</option>
          {options.bindings.map((row) => (
            <option key={bindingKey(row)} value={bindingKey(row)}>
              {row.label}
            </option>
          ))}
        </Select>
        <Select
          label="Decision connection"
          value={draft.selectorConnection}
          onChange={(event) => update({ selectorConnection: event.target.value })}
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
              At most one native decision and one exact execution. Decision errors, refusal and
              cancellation stop routing; there is no hidden chat, account or provider fallback.
              Enabling requires an authenticated client and compatible application settings.
            </p>
          </Card>
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
            candidates={validation?.candidates ?? []}
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
