import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DifficultyOrderFields, {
  difficultyOrderLabel,
} from "@/app/(dashboard)/dashboard/combos/decision/DifficultyOrderFields";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
afterEach(cleanup);

describe("explicit difficulty preference creation", () => {
  it("copies the base order only on explicit creation and keeps the input immutable", () => {
    const orders = { reasoning: ["medium", "high"] };
    const update = vi.fn();
    render(<DifficultyOrderFields orders={orders} disabled={false} update={update} />);
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add difficulty-specific order" }));
    expect(update).toHaveBeenCalledWith({
      reasoning: ["medium", "high"],
      "reasoning:difficult": ["medium", "high"],
    });
    expect(orders).toEqual({ reasoning: ["medium", "high"] });
    expect(update.mock.calls[0][0]["reasoning:difficult"]).not.toBe(orders.reasoning);
  });

  it("uses labeled controls for task and unknown difficulty without inventing a route", () => {
    const update = vi.fn();
    render(<DifficultyOrderFields orders={{}} disabled={false} update={update} />);
    fireEvent.change(screen.getByLabelText("Base task for difficulty preferences"), {
      target: { value: "complex_code" },
    });
    fireEvent.change(screen.getByLabelText("Local difficulty preference level"), {
      target: { value: "unknown" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add difficulty-specific order" }));
    expect(update).toHaveBeenCalledWith({ "complex_code:unknown": [] });
  });

  it("prevents duplicate or disabled edits", () => {
    const update = vi.fn();
    const { rerender } = render(
      <DifficultyOrderFields
        orders={{ "reasoning:difficult": ["high"] }}
        disabled={false}
        update={update}
      />
    );
    expect(
      (screen.getByRole("button", { name: "Add difficulty-specific order" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    rerender(<DifficultyOrderFields orders={{}} disabled update={update} />);
    expect(
      (screen.getByLabelText("Base task for difficulty preferences") as HTMLSelectElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add difficulty-specific order" }));
    expect(update).not.toHaveBeenCalled();
  });

  it("does not label arbitrary custom keys as trusted difficulty mappings", () => {
    expect(difficultyOrderLabel("complex_code:difficult")).toBe(
      "Complex code / difficult (local estimate)"
    );
    expect(difficultyOrderLabel("complex_code:superhuman")).toBeNull();
    expect(difficultyOrderLabel("__proto__:critical")).toBeNull();
    expect(difficultyOrderLabel("reasoning:easy:extra")).toBeNull();
  });
});
