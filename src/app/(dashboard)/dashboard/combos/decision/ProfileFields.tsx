"use client";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import DifficultyOrderFields, { difficultyOrderLabel } from "./DifficultyOrderFields";
import type { Candidate, Draft, EditorOptions } from "./decisionRoutingDraft";
import {
  addProfile,
  changeProfile,
  EFFORTS,
  moveInOrder,
  orderPatch,
  readOrders,
  readProfiles,
  removeProfile,
  TASK_LABELS,
} from "./profileDraftControls";

type Props = {
  draft: Draft;
  options: EditorOptions;
  disabled: boolean;
  update: (patch: Partial<Draft>) => void;
};
type RowProps = { row: Candidate; disabled: boolean; edit: (patch: Partial<Candidate>) => void };
type TaskProps = {
  profiles: Candidate[];
  orders: Record<string, string[]>;
  disabled: boolean;
  update: Props["update"];
};
const JSON_CLASS =
  "mt-2 min-h-40 w-full rounded-control border border-border bg-bg p-3 font-mono text-sm text-text-main";
function CapabilityFields({
  row,
  disabled,
  edit,
}: {
  row: Candidate;
  disabled: boolean;
  edit: (patch: Partial<Candidate>) => void;
}) {
  return (
    <>
      {(["text", "reasoning", "images", "tools"] as const).map((key) => (
        <Select
          key={key}
          label={`${key[0].toUpperCase() + key.slice(1)} support for ${row.id}`}
          value={
            row.capabilities[key] === null
              ? "unknown"
              : String(row.capabilities[key] ? "yes" : "no")
          }
          disabled={disabled}
          onChange={(event) =>
            edit({
              capabilities: {
                ...row.capabilities,
                [key]: event.target.value === "unknown" ? null : event.target.value === "yes",
              },
            })
          }
        >
          <option value="unknown">Unknown</option>
          <option value="yes">Declared supported</option>
          <option value="no">Declared unsupported</option>
        </Select>
      ))}
      <Input
        label={`Context limit for ${row.id}`}
        type="number"
        min={1}
        value={row.capabilities.contextTokens ?? ""}
        disabled={disabled}
        onChange={(event) =>
          edit({
            capabilities: {
              ...row.capabilities,
              contextTokens: event.target.value === "" ? null : Number(event.target.value),
            },
          })
        }
      />
      <Input
        label={`Profile evidence for ${row.id}`}
        value={row.evidence ?? ""}
        maxLength={500}
        disabled={disabled}
        onChange={(event) => edit({ evidence: event.target.value || null })}
      />
      <Input
        label={`Selection guidance for ${row.id}`}
        value={row.selectionGuidance ?? ""}
        maxLength={1000}
        disabled={disabled}
        onChange={(event) => edit({ selectionGuidance: event.target.value || undefined })}
      />
      <p className="text-xs text-text-muted">
        Optional operator preference. Local by default; sharing requires the separate destination
        acknowledgement in Decision task privacy. Never include secrets. Guidance cannot change hard
        eligibility or explicit client effort.
      </p>
    </>
  );
}
function SupportedEfforts({ row, disabled, edit }: RowProps) {
  return (
    <fieldset className="space-y-2">
      <legend>Supported efforts for {row.id}</legend>
      <p className="text-xs text-text-muted">
        {row.effort.supported === null
          ? "Unknown; no support has been declared."
          : "Operator declarations; not a live compatibility test."}
      </p>
      {EFFORTS.map((value) => (
        <label key={value} className="mr-3 inline-flex gap-2">
          <input
            type="checkbox"
            aria-label={`Supports ${value} effort for ${row.id}`}
            checked={row.effort.supported?.includes(value) ?? false}
            disabled={disabled}
            onChange={(event) =>
              edit({
                effort: {
                  ...row.effort,
                  supported: event.target.checked
                    ? [...(row.effort.supported ?? []), value]
                    : (row.effort.supported ?? []).filter((item) => item !== value),
                },
              })
            }
          />
          {value}
        </label>
      ))}
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled || row.effort.supported === null}
        onClick={() => edit({ effort: { ...row.effort, supported: null } })}
      >
        Reset supported efforts to unknown for {row.id}
      </Button>
    </fieldset>
  );
}
function EffortFields({
  row,
  disabled,
  edit,
}: {
  row: Candidate;
  disabled: boolean;
  edit: (patch: Partial<Candidate>) => void;
}) {
  return (
    <>
      <Select
        label={`Effort mode for ${row.id}`}
        value={row.effort.mode}
        disabled={disabled}
        onChange={(event) =>
          edit({
            effort: { ...row.effort, mode: event.target.value as Candidate["effort"]["mode"] },
          })
        }
      >
        <option value="set">Set exact effort</option>
        <option value="preserve">Preserve (unsupported here)</option>
        <option value="fixed">Fixed profile designation (exact supported slots only)</option>
      </Select>
      <Select
        label={`Effort for ${row.id}`}
        value={row.effort.value ?? ""}
        disabled={disabled}
        onChange={(event) =>
          edit({
            effort: {
              ...row.effort,
              value: (event.target.value || null) as Candidate["effort"]["value"],
            },
          })
        }
      >
        <option value="">Unknown / choose explicit effort</option>
        {EFFORTS.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </Select>
      <SupportedEfforts row={row} disabled={disabled} edit={edit} />
      <Input
        label={`Effort evidence for ${row.id}`}
        value={row.effort.evidence ?? ""}
        maxLength={500}
        disabled={disabled}
        onChange={(event) =>
          edit({ effort: { ...row.effort, evidence: event.target.value || null } })
        }
      />
    </>
  );
}
function IdentityFields({ row, draft, options, disabled, edit, update }: Props & RowProps) {
  return (
    <>
      <Select
        label={`Provider for ${row.id}`}
        value={row.provider}
        disabled={disabled}
        onChange={(event) => edit({ provider: event.target.value })}
      >
        <option value="">Choose a supported execution provider</option>
        <option value="openai">OpenAI API key</option>
        <option value="claude">Claude OAuth</option>
        <option value="agy">Antigravity OAuth (exact supported slots)</option>
        <option value="codex">Codex OAuth (provider-native output only)</option>
        {row.provider && !["openai", "claude", "agy", "codex"].includes(row.provider) && (
          <option value={row.provider}>{row.provider} (unsupported)</option>
        )}
      </Select>
      <Input
        label={`Model ID for ${row.id}`}
        value={row.model}
        maxLength={200}
        disabled={disabled}
        onChange={(event) => edit({ model: event.target.value })}
      />
      <Select
        label={`Endpoint kind for ${row.id}`}
        value={row.endpointKind}
        disabled={disabled}
        onChange={(event) =>
          edit({ endpointKind: event.target.value as Candidate["endpointKind"] })
        }
      >
        <option value="unknown">Unknown</option>
        <option value="direct">Direct</option>
        <option value="router">Router (unsupported)</option>
      </Select>
      <Select
        label={`Execution connection for ${row.id}`}
        value={draft.connections[row.id] ?? ""}
        disabled={disabled}
        onChange={(event) =>
          update({ connections: { ...draft.connections, [row.id]: event.target.value } })
        }
      >
        <option value="">Choose an explicit connection</option>
        {options.connections
          .filter((connection) => connection.provider === row.provider)
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
    </>
  );
}
function ProfileRow({
  row,
  draft,
  options,
  disabled,
  edit,
  remove,
  update,
}: Props & { row: Candidate; edit: (patch: Partial<Candidate>) => void; remove: () => void }) {
  return (
    <li className="rounded-control border border-border p-3">
      <h3 className="font-medium">
        {row.id}: {row.provider}/{row.model} · effort: {row.effort.value ?? "unknown"}
      </h3>
      <p className="mb-3 text-xs text-text-muted">
        Profile ID stays fixed. Changing provider or model clears its connection, capabilities and
        evidence.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <IdentityFields
          row={row}
          draft={draft}
          options={options}
          disabled={disabled}
          edit={edit}
          update={update}
        />
        <CapabilityFields row={row} edit={edit} disabled={disabled} />
        <EffortFields row={row} edit={edit} disabled={disabled} />
      </div>
      {(!row.evidence || !row.effort.evidence) && (
        <p className="mt-3 text-sm text-text-muted">
          Evidence is unknown. Missing profile or effort evidence leaves this candidate ineligible
          at runtime.
        </p>
      )}
      <Button size="sm" variant="secondary" className="mt-3" disabled={disabled} onClick={remove}>
        Remove execution profile {row.id}
      </Button>
    </li>
  );
}
function OrderEntries({
  values,
  label,
  task,
  orders,
  disabled,
  update,
}: Pick<TaskProps, "orders" | "disabled" | "update"> & {
  values: string[];
  label: string;
  task: string;
}) {
  return (
    <>
      {values.map((id, index) => (
        <li key={`${id}-${index}`} className="my-2 flex flex-wrap items-center gap-2">
          <span>{id}</span>
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Move ${id} earlier for ${label}`}
            disabled={disabled || index === 0}
            onClick={() => update(orderPatch(orders, task, moveInOrder(values, index, -1)))}
          >
            Move up
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Move ${id} later for ${label}`}
            disabled={disabled || index === values.length - 1}
            onClick={() => update(orderPatch(orders, task, moveInOrder(values, index, 1)))}
          >
            Move down
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Remove ${id} from ${label}`}
            disabled={disabled}
            onClick={() =>
              update(
                orderPatch(
                  orders,
                  task,
                  values.filter((_, item) => item !== index)
                )
              )
            }
          >
            Remove
          </Button>
        </li>
      ))}
    </>
  );
}
function TaskFields({
  profiles,
  orders,
  disabled,
  nativeOutput,
  update,
}: {
  profiles: Candidate[];
  orders: Record<string, string[]>;
  disabled: boolean;
  nativeOutput: boolean;
  update: Props["update"];
}) {
  const tasks = [...new Set([...Object.keys(TASK_LABELS), ...Object.keys(orders)])];
  return (
    <div className="mt-5 space-y-4">
      <h3 className="font-medium">Task preference orders</h3>
      <p className="text-sm text-text-muted">
        Choose which profiles each task may use, then order them. Empty or omitted categories have
        no route; unresolved is its own category, never a fallback. These are your preferences, not
        measured model quality. Image requests remain unsupported regardless of these orders. Custom
        category data is retained; no current request mapping is assumed.
      </p>
      <p className="text-sm text-text-muted">
        {nativeOutput
          ? "Native streaming function tools require a declared supported profile; a valid continuation keeps its original account, model and effort without another decision. Unsupported schemas and histories still reject."
          : "Tool requests use the tools order and only tool-capable profiles; a valid continuation keeps its original pair without a new decision."}
      </p>
      <DifficultyOrderFields
        orders={orders}
        disabled={disabled}
        update={(next) => update({ taskOrder: JSON.stringify(next, null, 2) })}
      />
      {tasks.map((task) => {
        const label = Object.hasOwn(TASK_LABELS, task)
          ? TASK_LABELS[task]
          : (difficultyOrderLabel(task) ?? `${task} (custom mapping unknown)`);
        const values = Object.hasOwn(orders, task) ? orders[task] : [];
        return (
          <fieldset key={task} className="rounded-control border border-border p-3">
            <legend>{label}</legend>
            {difficultyOrderLabel(task) && (
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() =>
                  update({
                    taskOrder: JSON.stringify(
                      Object.fromEntries(Object.entries(orders).filter(([key]) => key !== task)),
                      null,
                      2
                    ),
                  })
                }
              >
                Use base preferences for {label}
              </Button>
            )}
            <ol>
              <OrderEntries
                values={values}
                label={label}
                task={task}
                orders={orders}
                disabled={disabled}
                update={update}
              />
            </ol>
            <Select
              label={`Add profile to ${label}`}
              value=""
              disabled={disabled || profiles.every((row) => values.includes(row.id))}
              onChange={(event) => {
                if (event.target.value)
                  update(orderPatch(orders, task, [...values, event.target.value]));
              }}
            >
              <option value="">Choose a profile to add</option>
              {profiles
                .filter((row) => !values.includes(row.id))
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.id} — {row.model || "model unknown"} /{" "}
                    {row.effort.value ?? "effort unknown"}
                  </option>
                ))}
            </Select>
          </fieldset>
        );
      })}
    </div>
  );
}
function AdvancedFields({ draft, disabled, update }: Props) {
  return (
    <details className="mt-5">
      <summary className="cursor-pointer font-medium">Advanced JSON</summary>
      <p className="mt-2 text-sm text-text-muted">
        Optional full profile/task data. Unsupported or malformed data is retained for correction,
        never replaced with defaults. Strict validation still applies before saving.
      </p>
      <label htmlFor="decision-profiles" className="mt-4 block font-medium">
        Candidate profiles (JSON array)
      </label>
      <textarea
        id="decision-profiles"
        value={draft.candidates}
        onChange={(event) => update({ candidates: event.target.value })}
        disabled={disabled}
        maxLength={262144}
        spellCheck={false}
        className={JSON_CLASS}
      />
      <label htmlFor="decision-task-order" className="mt-4 block font-medium">
        Task preference orders (JSON object)
      </label>
      <textarea
        id="decision-task-order"
        value={draft.taskOrder}
        onChange={(event) => update({ taskOrder: event.target.value })}
        disabled={disabled}
        maxLength={262144}
        spellCheck={false}
        className={JSON_CLASS}
      />
    </details>
  );
}
export default function ProfileFields(props: Props) {
  const profiles = readProfiles(props.draft.candidates);
  const orders = readOrders(props.draft.taskOrder);
  const editable = profiles !== null && orders !== null;
  return (
    <Card title="Execution profiles and task preferences">
      <p className="text-sm text-text-muted">
        Declare exact provider/model/effort profiles and their evidence. No capabilities, rankings,
        live availability or account entitlement are inferred. OpenAI uses an explicit
        operator-supplied model ID. This bounded path supports claude-opus-5-5, claude-sonnet-5-5
        and claude-haiku-5-5 at medium/high/xhigh/max, plus exact agy/gemini-3.8-flash-high at High.
        The twelve Claude pairs have synthetic JSON and tool-streaming tests; plain-text streaming
        tests cover representative pairs. Live account access remains unverified. In bounded output,
        Tool requests need a profile that declares tool support; image and nonstreaming tool
        requests are unsupported. Codex and AGY Opus High stay excluded from bounded output. The
        distinct provider-native output opt-in permits only their exact original profiles for
        streaming text and guarded function-tool continuations, without a provider-enforced token
        ceiling.
      </p>
      {!editable && (
        <p role="alert" className="mt-3">
          Structured editing is unavailable until unsupported or malformed advanced JSON is
          corrected. Your text has been retained.
        </p>
      )}
      <Button
        className="my-4"
        variant="secondary"
        disabled={props.disabled || !editable || profiles.length >= 255}
        onClick={() => {
          if (profiles && orders)
            props.update({
              candidates: JSON.stringify(addProfile(profiles, props.draft, orders), null, 2),
            });
        }}
      >
        Add execution profile
      </Button>
      {profiles && orders && (
        <>
          <ul aria-label="Model and effort summary" className="space-y-4">
            {profiles.map((row) => (
              <ProfileRow
                key={row.id}
                {...props}
                row={row}
                edit={(patch) => props.update(changeProfile(props.draft, profiles, row.id, patch))}
                remove={() => props.update(removeProfile(props.draft, profiles, orders, row.id))}
              />
            ))}
          </ul>
          <TaskFields
            profiles={profiles}
            orders={orders}
            disabled={props.disabled}
            nativeOutput={props.draft.applicationMode === "provider-native-output-v1"}
            update={props.update}
          />
        </>
      )}
      <AdvancedFields {...props} />
    </Card>
  );
}
