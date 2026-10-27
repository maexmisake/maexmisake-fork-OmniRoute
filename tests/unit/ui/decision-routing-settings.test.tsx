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
  it("preserves opt-in scoped retry configuration across editing and save/reload", async () => {
    const savedPolicy = policy();
    savedPolicy.retry = { transitions: [{ from: "light", to: "deep", scopes: ["account-quota"] }] };
    savedPolicy.policy.maxExecutionAttempts = 2;
    savedPolicy.connections.deep = "execute-backup";
    const data = options();
    data.connections.push({
      ...data.connections.find((row) => row.id === "execute")!,
      id: "execute-backup",
    });
    const api = server(record(savedPolicy), data);
    render(<DecisionRoutingClient />);
    await chooseCombo();
    expect(
      (screen.getByLabelText("Enable configured execution failover") as HTMLInputElement).checked
    ).toBe(true);
    expect((screen.getByLabelText("Maximum execution attempts") as HTMLInputElement).value).toBe(
      "2"
    );
    fireEvent.change(screen.getByLabelText("Overall request timeout (ms)"), {
      target: { value: "29000" },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.calls.some((row) => row.init.method === "PUT")).toBe(true));
    const saved = api.calls.filter((row) => row.init.method === "PUT").at(-1)!.body!
      .policy as DecisionPolicyEditorValue;
    expect(saved.retry).toEqual(savedPolicy.retry);
    expect(saved.policy.maxExecutionAttempts).toBe(2);
    expect(
      (screen.getByLabelText("Enable configured execution failover") as HTMLInputElement).checked
    ).toBe(true);
  });
  it("keeps guidance local until destination acknowledgement and clears consent on edits or destination changes", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    const label = "Allow sharing operator selection guidance with this decision destination";
    expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText("Selection guidance for light"), {
      target: { value: "Prefer concise synthetic transformations" },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.calls.some((row) => row.init.method === "PUT")).toBe(true));
    let saved = api.calls.filter((row) => row.init.method === "PUT").at(-1)!.body!
      .policy as DecisionPolicyEditorValue;
    expect(saved.policy.candidates[0].selectionGuidance).toBe(
      "Prefer concise synthetic transformations"
    );
    expect(
      saved.selection?.mode === "native" && saved.selection.guidanceDisclosure
    ).toBeUndefined();
    fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(api.calls.filter((row) => row.init.method === "PUT")).toHaveLength(2)
    );
    saved = api.calls.filter((row) => row.init.method === "PUT").at(-1)!.body!
      .policy as DecisionPolicyEditorValue;
    if (saved.selection?.mode !== "native") throw new Error("Expected native fixture");
    expect(saved.selection.guidanceDisclosure).toEqual({
      acknowledgeExternalTransmission: true,
      provider: saved.selection.provider,
      model: saved.selection.model,
      connectionId: saved.selection.connectionId,
    });
    fireEvent.change(screen.getByLabelText("Selection guidance for light"), {
      target: { value: "Changed synthetic preference" },
    });
    expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText(label));
    fireEvent.change(screen.getByLabelText("Decision provider and exact model"), {
      target: { value: JSON.stringify(["opencode-zen", "jev-1.13"]) },
    });
    expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
  });
  it("requires disclosure consent, saves/reloads task context, and clears acknowledgement on provider changes", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    expect((screen.getByLabelText("Decision task context") as HTMLSelectElement).value).toBe(
      "local-summary"
    );
    fireEvent.change(screen.getByLabelText("Decision task context"), {
      target: { value: "task-text" },
    });
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(
      screen.getByLabelText(
        "I acknowledge that consented task text is sent to the decision provider"
      )
    );
    fireEvent.change(screen.getByLabelText("Maximum shared task characters"), {
      target: { value: "1024" },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.calls.some((row) => row.init.method === "PUT")).toBe(true));
    const saved = api.calls.find((row) => row.init.method === "PUT")!.body!
      .policy as DecisionPolicyEditorValue;
    expect(saved.selection?.mode).toBe("native");
    if (saved.selection?.mode !== "native") throw new Error("Expected native fixture");
    expect(saved.selection.decisionContext).toEqual({
      mode: "task-text",
      acknowledgeExternalTransmission: true,
      maxChars: 1024,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reload saved settings" }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Maximum shared task characters") as HTMLInputElement).value
      ).toBe("1024")
    );
    fireEvent.change(screen.getByLabelText("Decision provider and exact model"), {
      target: { value: JSON.stringify(["opencode-zen", "jev-1.13"]) },
    });
    expect(
      (
        screen.getByLabelText(
          "I acknowledge that consented task text is sent to the decision provider"
        ) as HTMLInputElement
      ).checked
    ).toBe(false);
    expect(saveButton().disabled).toBe(true);
  });
  it("retains all 23 exact original profile choices and fixed efforts when native output is explicitly saved", async () => {
    type Profile = DecisionPolicyEditorValue["policy"]["candidates"][number];
    const profiles: Profile[] = [];
    const add = (
      provider: string,
      model: string,
      effort: "medium" | "high" | "xhigh" | "max",
      fixed = false
    ) => {
      const id = `fixture-${profiles.length + 1}`;
      profiles.push({
        ...candidate(id, "high"),
        provider,
        model,
        effort: {
          mode: fixed ? "fixed" : "set",
          value: effort,
          supported: [effort],
          evidence: "Synthetic UI fixed/exact effort declaration; not live evidence",
        },
      });
    };
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])
      for (const effort of ["medium", "high", "xhigh", "max"] as const)
        add("claude", model, effort);
    add("codex", "gpt-6-luna", "max", true);
    for (const model of ["gpt-5.6-sol", "gpt-6-sol"])
      for (const effort of ["medium", "high", "xhigh", "max"] as const) add("codex", model, effort);
    add("agy", "gemini-3.8-flash-high", "high", true);
    add("agy", "claude-opus-4-6-thinking", "high", true);
    expect(profiles).toHaveLength(23);
    const value = policy();
    value.policy.candidates = profiles;
    value.policy.taskOrder = { reasoning: profiles.map((row) => row.id) };
    value.connections = Object.fromEntries(
      profiles.map((row) => [row.id, `execute-${row.provider}`])
    );
    const data = options();
    for (const provider of ["claude", "codex", "agy"])
      data.connections.push({
        ...data.connections[2],
        id: `execute-${provider}`,
        provider,
        label: `Synthetic ${provider} execution connection`,
      });
    const api = server(record(value), data);
    render(<DecisionRoutingClient />);
    await chooseCombo();
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Execution output policy"), {
      target: { value: "provider-native-output-v1" },
    });
    fireEvent.change(screen.getByLabelText("Output context-planning allowance (tokens)"), {
      target: { value: "512" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I acknowledge that provider-native output has no provider-enforced token ceiling",
      })
    );
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await screen.findByText("Routing settings saved.");
    const saved = api.calls.find((call) => call.init.method === "PUT")?.body
      ?.policy as DecisionPolicyEditorValue;
    expect(saved.policy.candidates).toEqual(profiles);
    expect(saved.policy.taskOrder).toEqual(value.policy.taskOrder);
    expect(saved.connections).toEqual(value.connections);
    expect(saved.nativeOutput).toEqual({
      acknowledgeNoTokenCeiling: true,
      contextOutputTokens: 512,
    });
    expect((screen.getByLabelText("Effort mode for fixture-23") as HTMLSelectElement).value).toBe(
      "fixed"
    );
    fireEvent.change(screen.getByLabelText("Effort mode for fixture-23"), {
      target: { value: "set" },
    });
    expect(saveButton().disabled).toBe(true);
    expect(
      screen.getByText(/unsupported provider\/model\/effort for this output policy/)
    ).toBeTruthy();
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(1);
  });

  it("keeps provider-native output off by default and requires explicit acknowledgement and allowance", async () => {
    const api = server(record(null, "unconfigured"));
    render(<DecisionRoutingClient />);
    await chooseCombo();
    expect((screen.getByLabelText("Execution output policy") as HTMLSelectElement).value).toBe(
      "bounded-v1"
    );
    expect(screen.queryByLabelText("Output context-planning allowance (tokens)")).toBeNull();
    fireEvent.change(screen.getByLabelText("Execution output policy"), {
      target: { value: "provider-native-output-v1" },
    });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    const acknowledge = screen.getByRole("checkbox", {
      name: "I acknowledge that provider-native output has no provider-enforced token ceiling",
    }) as HTMLInputElement;
    expect(acknowledge.checked).toBe(false);
    expect(acknowledge.getAttribute("aria-describedby")).toBe("native-output-disclosure");
    expect(
      (screen.getByLabelText("Output context-planning allowance (tokens)") as HTMLInputElement)
        .value
    ).toBe("");
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/Acknowledge that provider-native output/)).toBeTruthy();
    const copy = document.body.textContent ?? "";
    expect(copy).toContain("Caller max_tokens or max_completion_tokens is rejected");
    expect(copy).toContain("Only streaming requests are supported");
    expect(copy).toContain(
      "Native streaming function tools require a declared supported profile; a valid continuation keeps its original account, model and effort without another decision. Unsupported schemas and histories still reject."
    );
    expect(copy).toContain("Missing usage or cost remains unknown");
    expect(copy).toContain("Financially or token-capped client keys remain unsupported");
    expect(copy).toContain("AGY Opus High retains the original fixed profile designation");
    expect(api.calls.every((call) => !call.init.method || call.init.method === "GET")).toBe(true);
  });

  it("rejects missing, fractional and out-of-range native planning values without saving", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.change(screen.getByLabelText("Execution output policy"), {
      target: { value: "provider-native-output-v1" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I acknowledge that provider-native output has no provider-enforced token ceiling",
      })
    );
    for (const value of ["", "0", "-1", "1.5", "1000001"]) {
      fireEvent.change(screen.getByLabelText("Output context-planning allowance (tokens)"), {
        target: { value },
      });
      expect(saveButton().disabled).toBe(true);
      expect(screen.getByText(/Enter an explicit output context-planning allowance/)).toBeTruthy();
    }
    fireEvent.change(screen.getByLabelText("Output context-planning allowance (tokens)"), {
      target: { value: "128" },
    });
    expect(saveButton().disabled).toBe(false);
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(0);
  });

  it("saves native output explicitly, reloads it, and removes its acknowledgement on mode changes", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.change(screen.getByLabelText("Execution output policy"), {
      target: { value: "provider-native-output-v1" },
    });
    fireEvent.change(screen.getByLabelText("Output context-planning allowance (tokens)"), {
      target: { value: "512" },
    });
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "I acknowledge that provider-native output has no provider-enforced token ceiling",
      })
    );
    fireEvent.click(saveButton());
    await screen.findByText("Routing settings saved.");
    const first = api.calls.find((call) => call.init.method === "PUT")!;
    const saved = first.body?.policy as DecisionPolicyEditorValue;
    expect(first.body?.revision).toBe(REVISION);
    expect(saved.applicationMode).toBe("provider-native-output-v1");
    expect(saved.nativeOutput).toEqual({
      acknowledgeNoTokenCeiling: true,
      contextOutputTokens: 512,
    });
    expect(saved.policy.candidates).toEqual(policy().policy.candidates);
    expect(saved.policy.taskOrder).toEqual(policy().policy.taskOrder);
    fireEvent.click(screen.getByRole("button", { name: "Reload saved settings" }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Output context-planning allowance (tokens)") as HTMLInputElement)
          .value
      ).toBe("512")
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: "I acknowledge that provider-native output has no provider-enforced token ceiling",
        }) as HTMLInputElement
      ).checked
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Output context-planning allowance (tokens)"), {
      target: { value: "900" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(
      (screen.getByLabelText("Output context-planning allowance (tokens)") as HTMLInputElement)
        .value
    ).toBe("512");
    fireEvent.change(screen.getByLabelText("Execution output policy"), {
      target: { value: "bounded-v1" },
    });
    fireEvent.click(saveButton());
    await screen.findByText("Routing settings saved.");
    const second = api.calls.filter((call) => call.init.method === "PUT")[1].body
      ?.policy as DecisionPolicyEditorValue;
    expect(second.applicationMode).toBe("bounded-v1");
    expect(Object.hasOwn(second, "nativeOutput")).toBe(false);
    fireEvent.change(screen.getByLabelText("Execution output policy"), {
      target: { value: "provider-native-output-v1" },
    });
    expect(
      (
        screen.getByRole("checkbox", {
          name: "I acknowledge that provider-native output has no provider-enforced token ceiling",
        }) as HTMLInputElement
      ).checked
    ).toBe(false);
    expect(
      (screen.getByLabelText("Output context-planning allowance (tokens)") as HTMLInputElement)
        .value
    ).toBe("");
    expect(saveButton().disabled).toBe(true);
  });

  it("locks native policy controls during one pending save and recovers uncertain outcomes only by reload", async () => {
    const api = server();
    const pending = deferred<Response>();
    api.setIntercept((call) => (call.init.method === "PUT" ? pending.promise : undefined));
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.change(screen.getByLabelText("Execution output policy"), {
      target: { value: "provider-native-output-v1" },
    });
    fireEvent.change(screen.getByLabelText("Output context-planning allowance (tokens)"), {
      target: { value: "256" },
    });
    const ackName =
      "I acknowledge that provider-native output has no provider-enforced token ceiling";
    fireEvent.click(screen.getByRole("checkbox", { name: ackName }));
    fireEvent.click(saveButton());
    fireEvent.click(saveButton());
    expect((screen.getByLabelText("Execution output policy") as HTMLSelectElement).disabled).toBe(
      true
    );
    expect(
      (screen.getByLabelText("Output context-planning allowance (tokens)") as HTMLInputElement)
        .disabled
    ).toBe(true);
    expect((screen.getByRole("checkbox", { name: ackName }) as HTMLInputElement).disabled).toBe(
      true
    );
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(1);
    pending.reject(new Error(CANARY));
    await screen.findByText(/save outcome is unconfirmed/);
    expect(saveButton().disabled).toBe(true);
    expect(document.body.textContent).not.toContain(CANARY);
    api.setIntercept(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Reload saved settings" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Execution output policy") as HTMLSelectElement).value).toBe(
        "bounded-v1"
      )
    );
    expect(screen.queryByLabelText("Output context-planning allowance (tokens)")).toBeNull();
  });
  it("creates an explicit model-and-effort profile through structured controls without JSON", async () => {
    const api = server(record(null, "unconfigured"));
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.click(screen.getByRole("button", { name: "Add execution profile" }));
    expect((screen.getByLabelText("Text support for profile-1") as HTMLSelectElement).value).toBe(
      "unknown"
    );
    expect((screen.getByLabelText("Context limit for profile-1") as HTMLInputElement).value).toBe(
      ""
    );
    expect((screen.getByLabelText("Effort for profile-1") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Add profile to Explanation") as HTMLSelectElement).value).toBe(
      ""
    );
    fireEvent.change(screen.getByLabelText("Provider for profile-1"), {
      target: { value: "openai" },
    });
    fireEvent.change(screen.getByLabelText("Model ID for profile-1"), {
      target: { value: "synthetic-structured-fixture" },
    });
    fireEvent.change(screen.getByLabelText("Endpoint kind for profile-1"), {
      target: { value: "direct" },
    });
    fireEvent.change(screen.getByLabelText("Execution connection for profile-1"), {
      target: { value: "execute" },
    });
    fireEvent.change(screen.getByLabelText("Text support for profile-1"), {
      target: { value: "yes" },
    });
    fireEvent.change(screen.getByLabelText("Reasoning support for profile-1"), {
      target: { value: "yes" },
    });
    fireEvent.change(screen.getByLabelText("Context limit for profile-1"), {
      target: { value: "16000" },
    });
    fireEvent.change(screen.getByLabelText("Effort for profile-1"), { target: { value: "low" } });
    fireEvent.click(screen.getByLabelText("Supports low effort for profile-1"));
    fireEvent.change(screen.getByLabelText("Profile evidence for profile-1"), {
      target: { value: "Synthetic fixture declaration" },
    });
    fireEvent.change(screen.getByLabelText("Effort evidence for profile-1"), {
      target: { value: "Synthetic fixture effort declaration" },
    });
    fireEvent.change(screen.getByLabelText("Add profile to Explanation"), {
      target: { value: "profile-1" },
    });
    fireEvent.click(screen.getByRole("switch"));
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await screen.findByText("Routing settings saved.");
    const saved = api.calls.find((call) => call.init.method === "PUT")?.body
      ?.policy as DecisionPolicyEditorValue;
    expect(saved.policy.candidates[0]).toMatchObject({
      id: "profile-1",
      provider: "openai",
      model: "synthetic-structured-fixture",
      capabilities: {
        text: true,
        reasoning: true,
        images: null,
        tools: null,
        contextTokens: 16000,
      },
      effort: { mode: "set", value: "low", supported: ["low"] },
    });
    expect(saved.connections).toEqual({ "profile-1": "execute" });
    expect(saved.policy.taskOrder).toEqual({ explanation: ["profile-1"] });
    expect(saved.selection).toEqual({ mode: "deterministic" });
  });

  it("reorders task preferences and removes a profile atomically while preserving custom tasks", async () => {
    const value = policy();
    value.policy.taskOrder.custom_retained = ["light", "deep"];
    const api = server(record(value));
    render(<DecisionRoutingClient />);
    await chooseCombo();
    expect(
      (
        screen.getByRole("button", {
          name: "Move light earlier for Explanation",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Move deep later for Explanation" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move deep earlier for Explanation" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove execution profile light" }));
    fireEvent.change(screen.getByLabelText("Selection mode"), {
      target: { value: "deterministic" },
    });
    fireEvent.click(saveButton());
    await screen.findByText("Routing settings saved.");
    const saved = api.calls.find((call) => call.init.method === "PUT")?.body
      ?.policy as DecisionPolicyEditorValue;
    expect(saved.policy.candidates.map((row) => row.id)).toEqual(["deep"]);
    expect(saved.connections).toEqual({ deep: "execute" });
    expect(saved.policy.taskOrder).toEqual({
      explanation: ["deep"],
      reasoning: ["deep"],
      custom_retained: ["deep"],
    });
  });

  it("clears model-specific declarations on identity edits and discards them explicitly", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.change(screen.getByLabelText("Model ID for light"), {
      target: { value: "synthetic-different-fixture" },
    });
    expect((screen.getByLabelText("Text support for light") as HTMLSelectElement).value).toBe(
      "unknown"
    );
    expect((screen.getByLabelText("Profile evidence for light") as HTMLInputElement).value).toBe(
      ""
    );
    expect((screen.getByLabelText("Effort evidence for light") as HTMLInputElement).value).toBe("");
    expect(
      (screen.getByLabelText("Execution connection for light") as HTMLSelectElement).value
    ).toBe("");
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect((screen.getByLabelText("Model ID for light") as HTMLInputElement).value).toBe(
      "synthetic-execution-fixture"
    );
    expect((screen.getByLabelText("Text support for light") as HTMLSelectElement).value).toBe(
      "yes"
    );
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(0);
  });

  it("retains malformed advanced data and unsupported fields without resetting structured profiles", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.click(screen.getByText("Advanced JSON"));
    const malformed = "[unclosed synthetic fixture";
    fireEvent.change(screen.getByLabelText("Candidate profiles (JSON array)"), {
      target: { value: malformed },
    });
    expect(
      (screen.getByLabelText("Candidate profiles (JSON array)") as HTMLTextAreaElement).value
    ).toBe(malformed);
    expect(
      (screen.getByRole("button", { name: "Add execution profile" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(saveButton().disabled).toBe(true);
    const unsupported = JSON.stringify([
      { ...candidate("light", "low"), unsupportedFixture: true },
    ]);
    fireEvent.change(screen.getByLabelText("Candidate profiles (JSON array)"), {
      target: { value: unsupported },
    });
    expect(
      (screen.getByLabelText("Candidate profiles (JSON array)") as HTMLTextAreaElement).value
    ).toBe(unsupported);
    expect(
      (screen.getByRole("button", { name: "Add execution profile" }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect((screen.getByLabelText("Model ID for light") as HTMLInputElement).value).toBe(
      "synthetic-execution-fixture"
    );
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(0);
  });

  it("preserves inert custom dictionary keys during structured task edits", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    const taskText =
      '{"explanation":["light","deep"],"constructor":["light","deep"],"__proto__":["deep","light"],"image":["light"]}';
    fireEvent.change(screen.getByLabelText("Task preference orders (JSON object)"), {
      target: { value: taskText },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Move deep earlier for constructor (custom mapping unknown)",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove execution profile light" }));
    const draftOrders = JSON.parse(
      (screen.getByLabelText("Task preference orders (JSON object)") as HTMLTextAreaElement).value
    );
    expect(Object.hasOwn(draftOrders, "__proto__")).toBe(true);
    expect(draftOrders.__proto__).toEqual(["deep"]);
    expect(draftOrders.constructor).toEqual(["deep"]);
    expect(draftOrders.image).toEqual([]);
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/reserved task category __proto__ cannot be saved/)).toBeTruthy();
    expect(screen.getByRole("group", { name: "Image (unsupported)" })).toBeTruthy();
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(0);
  });

  it("does not adopt dangling task references or orphan connections when adding a profile", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.change(screen.getByLabelText("Task preference orders (JSON object)"), {
      target: { value: JSON.stringify({ explanation: ["profile-1"], reasoning: ["deep"] }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add execution profile" }));
    expect(screen.getByLabelText("Model ID for profile-2")).toBeTruthy();
    const rows = JSON.parse(
      (screen.getByLabelText("Candidate profiles (JSON array)") as HTMLTextAreaElement).value
    );
    expect(rows.at(-1).id).toBe("profile-2");
    const task = JSON.parse(
      (screen.getByLabelText("Task preference orders (JSON object)") as HTMLTextAreaElement).value
    );
    expect(task.explanation).toEqual(["profile-1"]);
    expect(
      (screen.getByLabelText("Execution connection for profile-2") as HTMLSelectElement).value
    ).toBe("");
    expect(saveButton().disabled).toBe(true);
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(0);
  });

  it("blocks ambiguous duplicate profile IDs without changing either advanced row", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    const duplicate = JSON.stringify([candidate("light", "low"), candidate("light", "high")]);
    fireEvent.change(screen.getByLabelText("Candidate profiles (JSON array)"), {
      target: { value: duplicate },
    });
    expect(
      (screen.getByRole("button", { name: "Add execution profile" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.queryByLabelText("Model ID for light")).toBeNull();
    expect(
      (screen.getByLabelText("Candidate profiles (JSON array)") as HTMLTextAreaElement).value
    ).toBe(duplicate);
    expect(saveButton().disabled).toBe(true);
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(0);
  });

  it("rejects unsupported structured effort and duplicate physical pairs without hiding declarations", async () => {
    const api = server();
    render(<DecisionRoutingClient />);
    await chooseCombo();
    fireEvent.change(screen.getByLabelText("Effort for light"), { target: { value: "high" } });
    expect(saveButton().disabled).toBe(true);
    expect((screen.getByLabelText("Effort for light") as HTMLSelectElement).value).toBe("high");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    fireEvent.change(screen.getByLabelText("Provider for light"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("Model ID for light"), {
      target: { value: "claude-opus-5-5" },
    });
    fireEvent.change(screen.getByLabelText("Effort for light"), { target: { value: "low" } });
    expect(saveButton().disabled).toBe(true);
    expect((screen.getByLabelText("Profile evidence for light") as HTMLInputElement).value).toBe(
      ""
    );
    expect(api.calls.filter((call) => call.init.method === "PUT")).toHaveLength(0);
  });

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
    const copy = document.body.textContent ?? "";
    expect(copy).toContain("plus exact agy/gemini-3.8-flash-high at High");
    expect(copy).toContain("Tool requests need a profile that declares tool support");
    expect(copy).toContain("Codex and AGY Opus High stay excluded");
    expect(copy).not.toMatch(/tool\/continuation requests are unsupported/i);
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
