// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateProviderConnectionSchema } from "../../../src/shared/validation/schemas/provider.ts";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: () => ({ notify: vi.fn() }),
}));

vi.mock("@/store/emailPrivacyStore", () => ({
  default: () => ({ hidden: false, toggle: vi.fn() }),
}));

vi.mock(
  "@/app/(dashboard)/dashboard/providers/[id]/components/modals/providerTierFieldApi",
  () => ({
    fetchProviderTierOverride: vi.fn().mockResolvedValue(""),
    saveProviderTierOverride: vi.fn().mockResolvedValue(undefined),
  })
);

const { default: EditConnectionModal } =
  await import("../../../src/app/(dashboard)/dashboard/providers/[id]/components/modals/EditConnectionModal.tsx");

const SYSTEM_ONE_TIER_SELECT = '[data-testid="system-one-tier-select"]';
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) } as Response))
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderModal(
  provider: string,
  providerSpecificData: Record<string, unknown> = {},
  onSave = vi.fn().mockResolvedValue(undefined)
) {
  act(() => {
    root.render(
      <EditConnectionModal
        isOpen={true}
        connection={{
          id: `conn-${provider}`,
          provider,
          authType: "apikey",
          name: `${provider} account`,
          providerSpecificData,
        }}
        providerId={provider}
        onSave={onSave}
        onClose={vi.fn()}
      />
    );
  });
  return onSave;
}

function systemOneTierSelect(): HTMLSelectElement | null {
  const advancedSettings = container.querySelector<HTMLButtonElement>(
    'button[aria-controls="edit-connection-advanced-settings"]'
  );
  if (advancedSettings?.getAttribute("aria-expanded") !== "true") {
    act(() => advancedSettings?.click());
  }
  return container.querySelector<HTMLSelectElement>(SYSTEM_ONE_TIER_SELECT);
}

async function chooseTier(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function save() {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === "save"
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

describe("EditConnectionModal — System One account tier", () => {
  it.each(["opencode-zen", "openrouter", "vercel-ai-gateway"])(
    "shows the tier selector for System One provider %s",
    (provider) => {
      renderModal(provider);
      expect(systemOneTierSelect()).not.toBeNull();
    }
  );

  it("does not show the tier selector for a provider outside System One", () => {
    renderModal("anthropic");
    expect(systemOneTierSelect()).toBeNull();
  });

  it("loads a stored free tier in the selector", () => {
    renderModal("opencode-zen", { systemOneTier: "free" });
    expect(systemOneTierSelect()?.value).toBe("free");
  });

  it("saves a newly selected free tier through the normal connection payload", async () => {
    const onSave = renderModal("opencode-zen", {
      retainedOperatorMetadata: { source: "existing" },
    });
    const select = systemOneTierSelect();
    expect(select?.value).toBe("");

    await chooseTier(select!, "free");
    await save();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].providerSpecificData).toMatchObject({
      systemOneTier: "free",
      retainedOperatorMetadata: { source: "existing" },
    });
  });

  it("clears free tier explicitly when returning to the default paid/unset behavior", async () => {
    const onSave = renderModal("opencode-zen", {
      systemOneTier: "free",
      retainedOperatorMetadata: "preserve me",
    });
    const select = systemOneTierSelect();
    expect(select?.value).toBe("free");

    await chooseTier(select!, "");
    await save();

    expect(onSave.mock.calls[0][0].providerSpecificData).toMatchObject({
      systemOneTier: null,
      retainedOperatorMetadata: "preserve me",
    });
  });

  it("accepts the free and cleared tier values in the normal provider update schema", () => {
    for (const systemOneTier of ["free", null]) {
      const result = updateProviderConnectionSchema.safeParse({
        providerSpecificData: { systemOneTier },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.providerSpecificData?.systemOneTier).toBe(systemOneTier);
      }
    }
  });
});
