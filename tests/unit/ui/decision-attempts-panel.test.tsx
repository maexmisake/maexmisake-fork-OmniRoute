import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import DecisionAttemptsPanel from "@/app/(dashboard)/dashboard/combos/decision/DecisionAttemptsPanel";
import { projectNativeAttemptPage } from "@/lib/decisionPolicy/attemptInspection";

const CANARY = "SYNTHETIC_PRIVATE_INSPECTION_BODY_NEVER_RENDER";
type Call = { url: string; init: RequestInit };
function page(id = "attempt-1", cost: number | null = null, cursor = false) {
  const data = projectNativeAttemptPage(
    [
      {
        id,
        request_id: "request-1",
        inspection_order: 42,
        combo_id: "combo-a",
        candidate_id: "deep",
        provider: "codex",
        model: "gpt-6-sol",
        effort: "max",
        state: "unknown",
        lane: "execution",
        input_tokens: null,
        output_tokens: 0,
        cost_usd: cost,
        http_status: 200,
        created_at: "2026-10-26T20:00:00Z",
        updated_at: "2026-10-26T20:00:01Z",
        lease_expires_at: 1,
        lease_owner: CANARY,
      },
    ],
    25,
    Date.parse("2026-10-26T21:00:00Z")
  );
  data.nextCursor = cursor ? "42" : null;
  return data;
}
function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function server(response: () => Promise<Response> | Response = () => Response.json(page())) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      expect(url).toMatch(/^\/api\/decision-routing\/attempts\?/);
      expect(init.method).toBeUndefined();
      expect(init.credentials).toBe("same-origin");
      expect(init.cache).toBe("no-store");
      expect(init.redirect).toBe("error");
      calls.push({ url, init });
      return response();
    })
  );
  return calls;
}
const reload = () => screen.getByRole("button", { name: "Reload recorded attempts" });
beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("native recorded-attempt inspection", () => {
  it("performs no automatic read and explicitly loads unknown cost without a provider action", async () => {
    const calls = server();
    render(<DecisionAttemptsPanel comboId="combo-a" />);
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/Unknown cost is not free/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry|run|test|recover|settle/i })).toBeNull();
    fireEvent.click(reload());
    await screen.findByRole("table", { name: "Recorded native decision and execution stages" });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url, "https://dashboard.example.invalid");
    expect(Object.fromEntries(url.searchParams)).toEqual({ combo: "combo-a", limit: "25" });
    expect(screen.getByText("codex/gpt-6-sol")).toBeTruthy();
    expect(screen.getByText("Effort: max")).toBeTruthy();
    expect(screen.getByText("Output: 0")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Reported cost (USD)" })).toBeTruthy();
    expect(screen.getByText("Unknown", { selector: "td" })).toBeTruthy();
    expect(document.body.textContent).not.toContain(CANARY);
  });
  it("labels refused decisions and expired pending leases without inferring execution success", async () => {
    const value = page();
    value.rows[0].state = "reserved";
    value.rows[0].lease = "expired";
    value.rows.push({
      ...value.rows[0],
      id: "decision-refused",
      lane: "decision",
      state: "completed",
      lease: "released",
      decisionOutcome: "refused",
      provider: "typesafe",
      model: "jev-1.14.0",
      applicationStatus: 409,
    });
    server(() => Response.json(value));
    render(<DecisionAttemptsPanel comboId="combo-a" />);
    fireEvent.click(reload());
    await screen.findByRole("table");
    expect(screen.getByText("Expired — outcome not inferred")).toBeTruthy();
    expect(screen.getByText("State: reserved")).toBeTruthy();
    expect(screen.getByText("Decision: refused")).toBeTruthy();
    expect(screen.getByText("Application HTTP: 409")).toBeTruthy();
  });
  it("reloads later exact zero cost and keyset pagination using read-only requests", async () => {
    let value = page("attempt-1", null, true);
    const calls = server(() => Response.json(value));
    render(<DecisionAttemptsPanel comboId="combo-a" />);
    fireEvent.click(reload());
    await screen.findByRole("table");
    value = page("older-attempt", 0);
    fireEvent.click(screen.getByRole("button", { name: "Read older attempts" }));
    await screen.findByText("execution · older-attempt");
    expect(
      new URL(calls[1].url, "https://dashboard.example.invalid").searchParams.get("cursor")
    ).toBe("42");
    expect(screen.getByText("$0", { selector: "td" })).toBeTruthy();
    value = page("attempt-1", 0.0000000001);
    fireEvent.click(reload());
    await screen.findByText("$1e-10", { selector: "td" });
    expect(
      new URL(calls[2].url, "https://dashboard.example.invalid").searchParams.has("cursor")
    ).toBe(false);
    expect(calls.every((call) => !call.init.body)).toBe(true);
  });
  it("hides raw error/malformed response bodies and allows a new explicit read", async () => {
    let response = Response.json({ error: CANARY }, { status: 403 });
    const calls = server(() => response);
    render(<DecisionAttemptsPanel comboId="combo-a" />);
    fireEvent.click(reload());
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toContain(CANARY);
    expect(screen.queryByRole("table")).toBeNull();
    response = Response.json({ ...page(), secret: CANARY });
    fireEvent.click(reload());
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(document.body.textContent).not.toContain(CANARY);
    response = Response.json(page());
    fireEvent.click(reload());
    await screen.findByRole("table");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls).toHaveLength(3);
  });
  it("aborts repeated reads and ignores late older refreshes", async () => {
    const first = deferred(),
      second = deferred();
    let index = 0;
    const calls = server(() => (index++ === 0 ? first.promise : second.promise));
    render(<DecisionAttemptsPanel comboId="combo-a" />);
    fireEvent.click(reload());
    expect(screen.getByRole("status").textContent).toContain("Reading recorded attempts");
    fireEvent.click(reload());
    expect(calls[0].init.signal?.aborted).toBe(true);
    second.resolve(Response.json(page("fresh-attempt")));
    await screen.findByText("execution · fresh-attempt");
    await act(async () => {
      first.resolve(Response.json(page("stale-attempt")));
    });
    await waitFor(() => expect(screen.queryByText("execution · stale-attempt")).toBeNull());
    expect(screen.getByText("execution · fresh-attempt")).toBeTruthy();
  });
  it("aborts on combo change/unmount and never adopts another combo's late result", async () => {
    const pending = deferred();
    const calls = server(() => pending.promise);
    const view = render(<DecisionAttemptsPanel comboId="combo-a" />);
    fireEvent.click(reload());
    view.rerender(<DecisionAttemptsPanel comboId="combo-b" />);
    expect(calls[0].init.signal?.aborted).toBe(true);
    expect(screen.queryByRole("table")).toBeNull();
    await act(async () => {
      pending.resolve(Response.json(page("wrong-combo")));
    });
    await waitFor(() => expect(screen.queryByText("execution · wrong-combo")).toBeNull());
    fireEvent.click(reload());
    view.unmount();
    expect(calls.at(-1)?.init.signal?.aborted).toBe(true);
  });
});
