"use client";

import { useEffect, useRef, useState } from "react";
import { NATIVE_DECISION_BINDINGS } from "@/shared/decisionPolicy/configuration";
import {
  bindingKey,
  draftFromPolicy,
  readSavedPolicy,
  type Connection,
  type Draft,
  type EditorOptions,
  type SavedPolicy,
} from "./decisionRoutingDraft";
import type { DecisionPolicyEditorValue } from "@/shared/decisionPolicy/configuration";

const EMPTY_OPTIONS: EditorOptions = { bindings: [], connections: [], combos: [] };

function readOptions(value: unknown): EditorOptions {
  if (!value || typeof value !== "object") throw new Error("Invalid options response");
  const row = value as EditorOptions;
  if (![row.bindings, row.connections, row.combos].every(Array.isArray))
    throw new Error("Invalid options response");
  const bindings = NATIVE_DECISION_BINDINGS.filter((binding) =>
    row.bindings.some((entry) => entry && bindingKey(entry) === bindingKey(binding))
  );
  const connections = row.connections.map((entry) => {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      typeof entry.provider !== "string" ||
      typeof entry.label !== "string" ||
      typeof entry.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.revision)
    )
      throw new Error("Invalid connection response");
    return {
      id: entry.id,
      provider: entry.provider,
      label: entry.label,
      active: entry.active === true,
      credentialPresent: entry.credentialPresent === true,
      freeTier: entry.freeTier === true,
      metadataCompatible: entry.metadataCompatible === true,
      revision: entry.revision,
    };
  });
  const combos = row.combos.map((entry) => {
    if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string")
      throw new Error("Invalid combo response");
    return { id: entry.id, name: entry.name };
  });
  return { bindings, connections, combos };
}

const policyPath = (id: string) => `/api/combos/${encodeURIComponent(id)}/decision-policy`;

async function putSettings(path: string, body: unknown): Promise<unknown> {
  // A committed PUT cannot be undone by aborting its response. Its caller
  // requires a reload whenever the outcome cannot be confirmed.
  const response = await fetch(path, {
    method: "PUT",
    credentials: "same-origin",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 409) throw new Error("stale");
  if (!response.ok) throw new Error("unconfirmed");
  return response.json();
}

function readTierResponse(value: unknown, expected?: { id: string; free: boolean }) {
  const connection = readOptions({ bindings: [], combos: [], connections: [value] }).connections[0];
  if (
    connection.id !== expected?.id ||
    connection.provider !== "opencode-zen" ||
    connection.freeTier !== expected.free
  )
    throw new Error("Unconfirmed connection response");
  return connection;
}

export function useDecisionRoutingEditor() {
  const [options, setOptions] = useState<EditorOptions>(EMPTY_OPTIONS);
  const [comboId, setComboId] = useState("");
  const [saved, setSaved] = useState<SavedPolicy | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reload, setReload] = useState(0);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<"policy" | "tier" | null>(null);
  const [mustReload, setMustReload] = useState(false);
  const mounted = useRef(true);
  const mutation = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/decision-routing/options", {
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Options unavailable");
        const next = readOptions(await response.json());
        if (!controller.signal.aborted) setOptions(next);
      } catch {
        if (!controller.signal.aborted) {
          setOptions(EMPTY_OPTIONS);
          setError("Unable to load configured routing options. Reload before editing.");
        }
      } finally {
        if (!controller.signal.aborted) setOptionsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!comboId) return;
    const controller = new AbortController();
    const current = ++generation.current;
    void (async () => {
      try {
        const response = await fetch(policyPath(comboId), {
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Settings unavailable");
        const next = readSavedPolicy(await response.json(), comboId);
        if (controller.signal.aborted || current !== generation.current) return;
        setSaved(next);
        setDraft(draftFromPolicy(next.policy));
      } catch {
        if (!controller.signal.aborted && current === generation.current) {
          setSaved(null);
          setDraft(null);
          setError("Unable to load saved routing settings. Reload before editing.");
        }
      } finally {
        if (!controller.signal.aborted && current === generation.current) setPolicyLoading(false);
      }
    })();
    return () => controller.abort();
  }, [comboId, reload]);

  const dirty = Boolean(
    saved && draft && JSON.stringify(draft) !== JSON.stringify(draftFromPolicy(saved.policy))
  );
  const busy = optionsLoading || policyLoading || pending !== null;

  const chooseCombo = (id: string) => {
    if (busy || dirty || mustReload || mutation.current) return;
    setSaved(null);
    setDraft(null);
    setError("");
    setNotice("");
    setPolicyLoading(Boolean(id));
    setComboId(id);
  };
  const updateDraft = (patch: Partial<Draft>) => {
    if (busy || mustReload || mutation.current) return;
    setNotice("");
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            ...patch,
            ...(patch.candidates !== undefined && patch.candidates !== previous.candidates
              ? { guidanceAcknowledged: false }
              : {}),
          }
        : null
    );
  };
  const reloadSaved = () => {
    if (mutation.current) return;
    setError("");
    setNotice("");
    setSaved(null);
    setDraft(null);
    setMustReload(false);
    setOptionsLoading(true);
    setPolicyLoading(Boolean(comboId));
    setReload((value) => value + 1);
  };
  const discard = () => {
    if (!saved || busy || mustReload || mutation.current) return;
    setDraft(draftFromPolicy(saved.policy));
    setNotice("Unsaved changes discarded.");
  };

  function receiveMutation(
    value: unknown,
    kind: "policy" | "tier",
    expectedConnection?: { id: string; free: boolean }
  ) {
    if (kind === "tier") {
      const connection = readTierResponse(value, expectedConnection);
      setOptions((previous) => ({
        ...previous,
        connections: previous.connections.map((entry) =>
          entry.id === connection.id ? connection : entry
        ),
      }));
      setNotice("Connection routing guard saved. Provider access is still unverified.");
      return;
    }
    const next = readSavedPolicy(value, comboId);
    setSaved(next);
    setDraft(draftFromPolicy(next.policy));
    setNotice(
      next.status === "disabled" ? "Saved routing is disabled." : "Routing settings saved."
    );
  }

  async function mutate(
    path: string,
    body: unknown,
    kind: "policy" | "tier",
    expectedConnection?: { id: string; free: boolean }
  ) {
    if (mutation.current || busy || mustReload || !saved) return;
    mutation.current = true;
    setPending(kind);
    setError("");
    setNotice("");
    try {
      const value = await putSettings(path, body);
      if (!mounted.current) return;
      receiveMutation(value, kind, expectedConnection);
    } catch (failure) {
      if (!mounted.current) return;
      setMustReload(true);
      setError(
        failure instanceof Error && failure.message === "stale"
          ? "Saved settings changed. Reload saved settings before continuing."
          : "The save outcome is unconfirmed. Reload saved settings before continuing."
      );
    } finally {
      mutation.current = false;
      if (mounted.current) setPending(null);
    }
  }

  const save = (policy: DecisionPolicyEditorValue) =>
    mutate(policyPath(comboId), { revision: saved?.revision, action: "save", policy }, "policy");
  const disable = () =>
    mutate(policyPath(comboId), { revision: saved?.revision, action: "disable" }, "policy");
  const setTier = (connection: Connection, tier: "free" | "paid") => {
    if (dirty || connection.provider !== "opencode-zen") return;
    return mutate(
      `/api/decision-routing/connections/${encodeURIComponent(connection.id)}/tier`,
      { revision: connection.revision, tier },
      "tier",
      { id: connection.id, free: tier === "free" }
    );
  };

  return {
    options,
    comboId,
    saved,
    draft,
    busy,
    dirty,
    pending,
    mustReload,
    error,
    notice,
    chooseCombo,
    updateDraft,
    reloadSaved,
    discard,
    save,
    disable,
    setTier,
  };
}
