"use client";

import { useEffect, useRef, useState } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import {
  nativeAttemptInspectionPageSchema,
  type NativeAttemptInspectionPage,
} from "@/lib/decisionPolicy/attemptInspection";

type Row = NativeAttemptInspectionPage["rows"][number];
const shown = (value: string | number | null) => (value === null ? "Unknown" : String(value));
function AttemptRows({ rows }: { rows: Row[] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="mb-3 text-left">Recorded native decision and execution stages</caption>
        <thead>
          <tr>
            {[
              "Stage and request",
              "Exact target",
              "Recorded outcome",
              "Usage (tokens)",
              "Reported cost (USD)",
              "Lease observation",
            ].map((label) => (
              <th key={label} scope="col" className="p-2">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${row.id ?? "unknown"}-${index}`}
              className="border-t border-border align-top"
            >
              <td className="p-2">
                <p>
                  {shown(row.lane)} · {shown(row.id)}
                </p>
                <p>Request: {shown(row.requestId)}</p>
                <p>Created: {shown(row.createdAt)}</p>
                <p>Updated: {shown(row.updatedAt)}</p>
              </td>
              <td className="p-2">
                <p>
                  {shown(row.provider)}/{shown(row.model)}
                </p>
                <p>Effort: {shown(row.effort)}</p>
                <p>Profile: {shown(row.candidateId)}</p>
                {row.selected && (
                  <p>
                    Selected: {shown(row.selected.provider)}/{shown(row.selected.model)} ·{" "}
                    {shown(row.selected.effort)}
                  </p>
                )}
              </td>
              <td className="p-2">
                <p>State: {shown(row.state)}</p>
                <p>
                  Decision:{" "}
                  {row.lane === "execution"
                    ? "Not applicable to an execution stage"
                    : shown(row.decisionOutcome)}
                </p>
                <p>Provider HTTP: {shown(row.httpStatus)}</p>
                <p>Application HTTP: {shown(row.applicationStatus)}</p>
                <details>
                  <summary>Allowlisted trace metadata</summary>
                  <ul>
                    {row.trace.map((entry, i) => (
                      <li key={i}>
                        {entry.phase}: {entry.candidateId ?? "no profile"} —{" "}
                        {entry.reasons.join(", ")}
                      </li>
                    ))}
                  </ul>
                </details>
              </td>
              <td className="p-2">
                <p>Input: {shown(row.inputTokens)}</p>
                <p>Output: {shown(row.outputTokens)}</p>
                <p>Reasoning: {shown(row.reasoningTokens)}</p>
                <p>Cache read: {shown(row.cacheReadTokens)}</p>
                <p>Cache creation: {shown(row.cacheCreationTokens)}</p>
              </td>
              <td className="p-2">
                {row.costUsd === null ? "Unknown" : `$${String(row.costUsd)}`}
              </td>
              <td className="p-2">
                {row.lease === "expired" ? "Expired — outcome not inferred" : row.lease}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AttemptInspectionSession({ comboId }: { comboId: string }) {
  const [page, setPage] = useState<NativeAttemptInspectionPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sessionRef = useRef({
    active: true,
    generation: 0,
    controller: null as AbortController | null,
  });
  useEffect(() => {
    const session = sessionRef.current;
    session.active = true;
    return () => {
      session.active = false;
      session.controller?.abort();
    };
  }, []);

  async function load(cursor?: string) {
    if (!comboId) return;
    const session = sessionRef.current;
    const current = ++session.generation;
    session.controller?.abort();
    const request = new AbortController();
    session.controller = request;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ combo: comboId, limit: "25" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`/api/decision-routing/attempts?${query}`, {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal: request.signal,
      });
      if (!response.ok) throw new Error("inspection_unavailable");
      const data = nativeAttemptInspectionPageSchema.parse(await response.json());
      if (session.active && !request.signal.aborted && current === session.generation)
        setPage(data);
    } catch {
      if (session.active && !request.signal.aborted && current === session.generation) {
        setPage(null);
        setError(
          "Recorded attempts are unavailable. A signed-in operator is required; reload to try the read again."
        );
      }
    } finally {
      if (session.active && !request.signal.aborted && current === session.generation)
        setLoading(false);
    }
  }

  return (
    <Card title="Recorded native attempts">
      <p className="text-sm text-text-muted">
        Read-only journal metadata for this combo. Nothing is read until you reload. These are
        actual recorded stages, not recomputed routing scores. Unknown cost is not free. Lease
        expiry does not prove a provider call stopped; do not replay uncertain work. Reload observes
        later receipts without changing them.
      </p>
      <p className="mt-2 text-xs text-text-muted">
        Only a bounded allowlisted trace subset is shown. No prompts, credentials, account
        identifiers, raw errors or lease-owner capabilities are returned. No retries, recovery
        probes or settlement actions are provided.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <Button variant="outline" disabled={!comboId} onClick={() => void load()}>
          Reload recorded attempts
        </Button>
        <Button
          variant="outline"
          disabled={loading || !page?.nextCursor}
          onClick={() => void load(page?.nextCursor ?? undefined)}
        >
          Read older attempts
        </Button>
      </div>
      {loading && (
        <p role="status" className="mt-3">
          Reading recorded attempts…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3">
          {error}
        </p>
      )}
      {page && (
        <p className="mt-3 text-xs text-text-muted">
          Observed: {page.observedAt}. Showing {page.rows.length} recorded stages.
        </p>
      )}
      {page?.rows.length === 0 && <p className="mt-3">No recorded attempts match this page.</p>}
      {page && page.rows.length > 0 && <AttemptRows rows={page.rows} />}
    </Card>
  );
}

export default function DecisionAttemptsPanel({ comboId }: { comboId: string }) {
  return <AttemptInspectionSession key={comboId} comboId={comboId} />;
}
