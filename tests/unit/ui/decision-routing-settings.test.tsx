import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DecisionRoutingClient from "@/app/(dashboard)/dashboard/combos/decision/DecisionRoutingClient";
import {
  NATIVE_DECISION_BINDINGS,
  type DecisionPolicyEditorValue,
} from "@/shared/decisionPolicy/configuration";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

const REVISION = "a".repeat(64);
const UPDATED = "b".repeat(64);
const CANARY = "SYNTHETIC-PRIVATE-RESPONSE-NEVER-RENDER";
let unexpectedCalls: string[] = [];
type Call = { url: string; init: RequestInit; body: Record<string, unknown> | null };
type RecordResponse = {
  comboId: string;
  name: string;
  revision: string;
  status: string;
  policy: unknown;
  issues: string[];
};

function candidate(id: string, effort: "low" | "high") {
  return {
    id,
    provider: "openai",
    model: "synthetic-execution-fixture",
    endpointKind: "direct" as const,
    evidence: "Synthetic UI fixture; no live model capability claim",
    capabilities: {
      text: true,
      images: false,
      tools: false,
      reasoning: true,
      contextTokens: 16000,
    },
    effort: {
      mode: "set" as const,
      value: effort,
      supported: ["low" as const, "high" as const],
      evidence: "Synthetic supported efforts",
    },
  };
}

function policy(): DecisionPolicyEditorValue {
  return {
    enabled: true,
    applicationMode: "bounded-v1",
    selection: {
      mode: "native",
      provider: "opencode-zen",
      model: "jev-1.13-free",
      connectionId: "zen-free",
      timeoutMs: 8000,
      maxCandidates: 32,
    },
    connections: { light: "execute", deep: "execute" },
    policy: {
      version: 1,
      candidates: [candidate("light", "low"), candidate("deep", "high")],
      taskOrder: { explanation: ["light", "deep"], reasoning: ["deep", "light"] },
      unknownQuota: "reject",
      decisionFailure: "stop",
      maxDecisionAttempts: 1,
      maxExecutionAttempts: 1,
      timeoutMs: 30000,
    },
  };
}

function options() {
  return {
    bindings: NATIVE_DECISION_BINDINGS,
    connections: [
      {
        id: "zen-free",
        provider: "opencode-zen",
        label: "Synthetic free connection",
        active: true,
        credentialPresent: true,
        freeTier: true,
        metadataCompatible: true,
        revision: REVISION,
      },
      {
        id: "zen-paid",
        provider: "opencode-zen",
        label: "Synthetic paid connection",
        active: true,
        credentialPresent: true,
        freeTier: false,
        metadataCompatible: true,
        revision: REVISION,
      },
      {
        id: "execute",
        provider: "openai",
        label: "Synthetic execution connection",
        active: true,
        credentialPresent: true,
        freeTier: false,
        metadataCompatible: false,
        revision: REVISION,
      },
    ],
    combos: [
      { id: "combo-a", name: "Fixture combo A" },
      { id: "combo-b", name: "Fixture combo B" },
    ],
  };
}

function record(value: unknown = policy(), status = "enabled"): RecordResponse {
  return {
    comboId: "combo-a",
    name: "Fixture combo A",
    revision: REVISION,
    status,
    policy: value,
    issues: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function server(initial: RecordResponse = record(), initialOptions = options()) {
  const calls: Call[] = [];
  let current = initial;
  const data = initialOptions;
  let intercept: ((call: Call) => Promise<Response> | Response | undefined) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const allowed =
        /^\/api\/(?:decision-routing\/options|combos\/combo-[ab]\/decision-policy|decision-routing\/connections\/zen-(?:free|paid)\/tier)$/;
      if (!allowed.test(url) || ![undefined, "GET", "PUT"].includes(init.method)) {
        unexpectedCalls.push(url);
        throw new Error("Unexpected outbound operation");
      }
      expect(init.credentials).toBe("same-origin");
      expect(init.redirect).toBe("error");
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const call = { url, init, body };
      calls.push(call);
      const override = intercept?.(call);
      if (override) return override;
      if (url.endsWith("/options")) return Response.json(data);
      if (init.method === "PUT") {
        if (url.endsWith("/tier")) {
          const connection = data.connections.find((row) => url.includes(`/${row.id}/`))!;
          Object.assign(connection, { freeTier: body?.tier === "free", revision: UPDATED });
          return Response.json(connection);
        }
        const next = body?.action === "disable" ? null : body?.policy;
        current = {
          ...current,
          revision: UPDATED,
          policy: next,
          status: next && (next as DecisionPolicyEditorValue).enabled ? "enabled" : "disabled",
        };
      }
      return Response.json(current);
    })
  );
  return {
    calls,
    setIntercept: (value: typeof intercept) => {
      intercept = value;
    },
    setRecord: (value: RecordResponse) => {
      current = value;
    },
  };
}

async function chooseCombo() {
  await waitFor(() =>
    expect((screen.getByLabelText("Combo") as HTMLSelectElement).disabled).toBe(false)
  );
  fireEvent.change(screen.getByLabelText("Combo"), { target: { value: "combo-a" } });
  await screen.findByRole("switch", { name: "Enable decision routing for this combo" });
}

const saveButton = () => screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;

beforeEach(() => {
  vi.restoreAllMocks();
  unexpectedCalls = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(unexpectedCalls).toEqual([]);
});

describe("decision routing settings", () => {
  it("starts unconfigured and off, with no invented profiles or inference calls", async () => {
    const api = server(record(null, "unconfigured"));
    render(<DecisionRoutingClient />);
    await chooseCombo();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(
      (screen.getByLabelText("Candidate profiles (JSON array)") as HTMLTextAreaElement).value
    ).toBe("[]");
    expect(
      (screen.getByLabelText("Task preference orders (JSON object)") as HTMLTextAreaElement).value
    ).toBe("{}");
    expect(screen.queryByRole("button", { name: /test|run|discover/i })).toBeNull();
    expect(api.calls.map((call) => call.url)).toEqual([
      "/api/decision-routing/options",
      "/api/combos/combo-a/decision-policy",
    ]);
    expect(api.calls.every((call) => !call.init.method || call.init.method === "GET")).toBe(true);
  });

  it("edits the exact free binding, saves its revision and reloads the persisted result", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    expect(screen.getByText(/light: openai\/synthetic-execution-fixture/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Decision timeout (ms)"), { target: { value: "900" } });
    expect((screen.getByLabelText("Combo") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(saveButton());
    await screen.findByText("Routing settings saved.");
    const put = api.calls.find((call) => call.init.method === "PUT")!;
    const saved = put.body?.policy as DecisionPolicyEditorValue;
    expect(put.body?.revision).toBe(REVISION);
    expect(saved.selection).toMatchObject({
      provider: "opencode-zen",
      model: "jev-1.13-free",
      timeoutMs: 900,
    });
    expect(saved.policy).toMatchObject({
      maxExecutionAttempts: 1,
      maxDecisionAttempts: 1,
      decisionFailure: "stop",
    });
    expect(saved.policy.candidates.map((row) => row.effort.value)).toEqual(["low", "high"]);
    fireEvent.click(screen.getByRole("button", { name: "Reload saved settings" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Decision timeout (ms)") as HTMLInputElement).value).toBe("900")
    );
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(1);
  });

  it("rejects malformed/unsupported profiles and wrong-tier selection before saving", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.change(screen.getByLabelText("Candidate profiles (JSON array)"), {
      target: { value: "not JSON" },
    });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/Check the version 1 profile/)).toBeTruthy();
    const invalid = policy().policy.candidates.map((row) => ({ ...row, provider: "codex" }));
    fireEvent.change(screen.getByLabelText("Candidate profiles (JSON array)"), {
      target: { value: JSON.stringify(invalid) },
    });
    expect(screen.getByText(/unsupported provider\/model\/effort/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    fireEvent.change(screen.getByLabelText("Decision connection"), {
      target: { value: "zen-paid" },
    });
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/cannot currently activate/)).toBeTruthy();
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(0);
  });

  it("keeps deterministic mode separate and preserves explicit task orders", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.change(screen.getByLabelText("Selection mode"), {
      target: { value: "deterministic" },
    });
    expect(screen.queryByLabelText("Decision connection")).toBeNull();
    fireEvent.click(saveButton());
    await screen.findByText("Routing settings saved.");
    const saved = api.calls.find((call) => call.init.method === "PUT")?.body
      ?.policy as DecisionPolicyEditorValue;
    expect(saved.selection).toEqual({ mode: "deterministic" });
    expect(saved.policy.maxDecisionAttempts).toBe(0);
    expect(saved.policy.taskOrder).toEqual(policy().policy.taskOrder);
  });

  it("blocks unsupported selector metadata and out-of-range timeout/candidate edits", async () => {
    const data = options();
    data.connections[0].metadataCompatible = false;
    const api = server(record(), data);
    render(<DecisionRoutingClient />);
    await chooseCombo();
    expect(saveButton().disabled).toBe(true);
    expect(screen.getAllByText(/unsupported metadata is preserved/i).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Decision timeout (ms)"), {
      target: { value: "10001" },
    });
    expect(screen.getByText(/Check the version 1 profile/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Decision timeout (ms)"), {
      target: { value: "8000" },
    });
    fireEvent.change(screen.getByLabelText("Maximum decision candidates"), {
      target: { value: "256" },
    });
    expect(saveButton().disabled).toBe(true);
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(0);
  });

  it("does not echo an invalid stored policy or server error body, and can disable it", async () => {
    const api = server(record({ apiKey: CANARY, privateState: CANARY }, "invalid"));
    render(<DecisionRoutingClient />);
    await chooseCombo();
    expect(screen.getByText(/Stored policy is invalid/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(CANARY);
    expect(
      (screen.getByLabelText("Candidate profiles (JSON array)") as HTMLTextAreaElement).value
    ).not.toContain(CANARY);
    fireEvent.click(screen.getByRole("button", { name: "Disable saved routing" }));
    await screen.findByText("Saved routing is disabled.");
    expect(api.calls.find((call) => call.init.method === "PUT")?.body).toEqual({
      revision: REVISION,
      action: "disable",
    });
  });

  it("handles stale saves with a mandatory reload and a fresh revision", async () => {
    const api = server();
    api.setIntercept((call) =>
      call.init.method === "PUT"
        ? Response.json({ error: { message: CANARY } }, { status: 409 })
        : undefined
    );
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.change(screen.getByLabelText("Decision timeout (ms)"), { target: { value: "700" } });
    fireEvent.click(saveButton());
    await screen.findByText(/Saved settings changed/);
    expect(saveButton().disabled).toBe(true);
    expect((screen.getByLabelText("Decision timeout (ms)") as HTMLInputElement).disabled).toBe(
      true
    );
    expect(document.body.textContent).not.toContain(CANARY);
    const next = policy();
    if (next.selection?.mode === "native") next.selection.timeoutMs = 600;
    api.setRecord({ ...record(next), revision: UPDATED });
    api.setIntercept(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Reload saved settings" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Decision timeout (ms)") as HTMLInputElement).value).toBe("600")
    );
    fireEvent.change(screen.getByLabelText("Decision timeout (ms)"), { target: { value: "500" } });
    fireEvent.click(saveButton());
    await screen.findByText("Routing settings saved.");
    expect(api.calls.filter((call) => call.init.method === "PUT")[1].body?.revision).toBe(UPDATED);
  });

  it("locks editing/discard during a pending write and never duplicates or claims an undo", async () => {
    const api = server();
    const pending = deferred<Response>();
    api.setIntercept((call) => (call.init.method === "PUT" ? pending.promise : undefined));
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.click(saveButton());
    fireEvent.click(saveButton());
    expect(
      (screen.getByRole("button", { name: "Discard changes" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reload saved settings" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(1);
    expect(api.calls.find((call) => call.init.method === "PUT")?.init.signal).toBeUndefined();
    pending.reject(new Error(CANARY));
    await screen.findByText(/save outcome is unconfirmed/);
    expect(document.body.textContent).not.toContain(CANARY);
    expect(saveButton().disabled).toBe(true);
  });

  it("aborts abandoned reads and does not apply their late results to a reopened editor", async () => {
    const api = server();
    const pending = deferred<Response>();
    api.setIntercept((call) =>
      call.url.endsWith("/decision-policy") ? pending.promise : undefined
    );
    const first = render(<DecisionRoutingClient />);
    await waitFor(() =>
      expect((screen.getByLabelText("Combo") as HTMLSelectElement).disabled).toBe(false)
    );
    fireEvent.change(screen.getByLabelText("Combo"), { target: { value: "combo-a" } });
    const abandoned = api.calls.find((call) => call.url.endsWith("/decision-policy"))!;
    first.unmount();
    expect(abandoned.init.signal?.aborted).toBe(true);
    api.setIntercept(undefined);
    render(<DecisionRoutingClient />);
    await chooseCombo();
    pending.resolve(Response.json(record(null, "unconfigured")));
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true")
    );
    expect((screen.getByLabelText("Decision connection") as HTMLSelectElement).value).toBe(
      "zen-free"
    );
  });

  it("configures an untagged Zen guard, then explicitly configures and saves native free routing", async () => {
    const api = server(record(null, "unconfigured"));
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.change(screen.getByLabelText("Zen connection guard"), {
      target: { value: "zen-paid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set free routing guard" }));
    await screen.findByText(/Connection routing guard saved/);
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(1);
    expect(api.calls.find((call) => call.init.method === "PUT")?.body).toEqual({
      revision: REVISION,
      tier: "free",
    });
    expect(screen.getByText("Current routing guard: free.")).toBeTruthy();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    fireEvent.change(screen.getByLabelText("Selection mode"), { target: { value: "native" } });
    fireEvent.change(screen.getByLabelText("Decision provider and exact model"), {
      target: { value: JSON.stringify(["opencode-zen", "jev-1.13-free"]) },
    });
    fireEvent.change(screen.getByLabelText("Decision connection"), {
      target: { value: "zen-paid" },
    });
    fireEvent.change(screen.getByLabelText("Candidate profiles (JSON array)"), {
      target: { value: JSON.stringify(policy().policy.candidates) },
    });
    fireEvent.change(screen.getByLabelText("Task preference orders (JSON object)"), {
      target: { value: JSON.stringify(policy().policy.taskOrder) },
    });
    for (const id of ["light", "deep"]) {
      fireEvent.change(screen.getByLabelText(`Execution connection for ${id}`), {
        target: { value: "execute" },
      });
    }
    fireEvent.click(screen.getByRole("switch"));
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await screen.findByText("Routing settings saved.");
    const puts = api.calls.filter((call) => call.init.method === "PUT");
    expect(puts).toHaveLength(2);
    expect((puts[1].body?.policy as DecisionPolicyEditorValue).selection).toMatchObject({
      provider: "opencode-zen",
      model: "jev-1.13-free",
      connectionId: "zen-paid",
    });
  });

  it("preserves unknown evidence without inventing it and enforces the whole-save byte bound", async () => {
    const value = policy();
    value.policy.candidates[0].evidence = null;
    value.policy.candidates[0].effort.evidence = null;
    const api = server(record(value));
    render(<DecisionRoutingClient />);
    await chooseCombo();
    expect(screen.getByText(/Evidence is unknown/)).toBeTruthy();
    fireEvent.click(saveButton());
    await screen.findByText("Routing settings saved.");
    const saved = api.calls.find((call) => call.init.method === "PUT")?.body
      ?.policy as DecisionPolicyEditorValue;
    expect(saved.policy.candidates[0].evidence).toBeNull();
    expect(saved.policy.candidates[0].effort.evidence).toBeNull();
    const profiles = Array.from({ length: 100 }, (_, index) => ({
      ...candidate(`fixture-${index}`, "low"),
      model: `synthetic-${index}`,
      evidence: "x".repeat(500),
      effort: { ...candidate("unused", "low").effort, evidence: "y".repeat(500) },
    }));
    fireEvent.change(screen.getByLabelText("Candidate profiles (JSON array)"), {
      target: { value: JSON.stringify(profiles) },
    });
    fireEvent.change(screen.getByLabelText("Task preference orders (JSON object)"), {
      target: { value: "{}" },
    });
    expect(screen.getByText(/complete settings save must fit within 64 KiB/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });
});
