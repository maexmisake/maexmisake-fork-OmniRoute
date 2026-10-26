"use client";

import { useState } from "react";
import Button from "@/shared/components/Button";
import Select from "@/shared/components/Select";
import { TASK_LABELS } from "./profileDraftControls";

const LEVELS = ["easy", "moderate", "difficult", "critical", "unknown"] as const;
export function difficultyOrderLabel(key: string): string | null {
  const parts = key.split(":");
  if (
    parts.length !== 2 ||
    !Object.hasOwn(TASK_LABELS, parts[0]) ||
    !LEVELS.some((level) => level === parts[1])
  )
    return null;
  return `${TASK_LABELS[parts[0]]} / ${parts[1]} (local estimate)`;
}

export default function DifficultyOrderFields({
  orders,
  disabled,
  update,
}: {
  orders: Record<string, string[]>;
  disabled: boolean;
  update: (orders: Record<string, string[]>) => void;
}) {
  const [task, setTask] = useState("reasoning");
  const [level, setLevel] = useState<string>("difficult");
  const key = `${task}:${level}`;
  const exists = Object.hasOwn(orders, key);
  const add = () => {
    if (disabled || exists || !difficultyOrderLabel(key)) return;
    const original = Object.hasOwn(orders, task) ? orders[task] : [];
    update({ ...orders, [key]: [...original] });
  };
  return (
    <fieldset className="space-y-3 rounded-control border border-border p-3">
      <legend>Optional difficulty preferences</legend>
      <p className="text-sm text-text-muted">
        Local difficulty is an auditable heuristic, not measured quality. Without an explicit
        difficulty order, the base task order stays unchanged. A new order copies the current base
        preferences; an empty order has no route. It cannot override authorization, supported
        capabilities or explicit client effort.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Base task for difficulty preferences"
          value={task}
          disabled={disabled}
          onChange={(event) => setTask(event.target.value)}
        >
          {Object.entries(TASK_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          label="Local difficulty preference level"
          value={level}
          disabled={disabled}
          onChange={(event) => setLevel(event.target.value)}
        >
          {LEVELS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
      </div>
      <Button variant="outline" size="sm" disabled={disabled || exists} onClick={add}>
        Add difficulty-specific order
      </Button>
      {exists && <p className="text-sm text-text-muted">This order is already listed below.</p>}
    </fieldset>
  );
}
