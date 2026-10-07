// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The attachment-storage switch and the bucket it writes to.
 *
 * The bucket's secrets used to be reachable only through the `fileUpload`
 * tool's panel; with that tool in a plugin, this card is where an operator sets
 * them. What has to hold: the switch alone writes only its flag, the bucket
 * fields are offered once storage is on, and the keys are saved before the
 * flag, so a failed key never leaves storage on against a half-set bucket.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { AttachmentStorageCard } from "./attachment-storage-card";
import { PageActionsProvider, usePageActions } from "./page-actions-context";
import type { Instance } from "@/lib/api";

const { mockUpdate, mockSecretsList, mockSecretsSet, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockSecretsList: vi.fn(),
  mockSecretsSet: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("@/lib/i18n/context", () => ({
  useI18n: vi.fn(() => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() })),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/lib/api", () => ({
  api: {
    instances: { update: (...args: unknown[]) => mockUpdate(...args) },
    secrets: {
      list: (...args: unknown[]) => mockSecretsList(...args),
      set: (...args: unknown[]) => mockSecretsSet(...args),
      delete: vi.fn(),
    },
  },
  getUserErrorMessage: vi.fn((_e: unknown, d: string) => d),
}));

function SaveButton() {
  const { saveAction } = usePageActions();
  if (!saveAction?.isDirty) return null;
  return <button onClick={() => saveAction.onSave()}>common.save</button>;
}

function renderWithProvider(ui: ReactElement) {
  return render(
    <PageActionsProvider>
      {ui}
      <SaveButton />
    </PageActionsProvider>,
  );
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "inst-1",
    slug: "a1",
    name: "A1",
    attachmentStorageEnabled: false,
    ...overrides,
  } as unknown as Instance;
}

const calls: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mockSecretsList.mockResolvedValue({ secrets: [] });
  mockSecretsSet.mockImplementation(async (_slug: string, entries: { key: string }[]) => {
    calls.push(...entries.map((e) => `secret:${e.key}`));
    return { secrets: [] };
  });
  mockUpdate.mockImplementation(async (_slug: string, patch: Record<string, unknown>) => {
    calls.push("flag");
    return { instance: makeInstance(patch as Partial<Instance>) };
  });
});

describe("AttachmentStorageCard", () => {
  it("hides the bucket fields while storage is off", () => {
    renderWithProvider(<AttachmentStorageCard instance={makeInstance()} onUpdate={vi.fn()} />);

    expect(screen.queryByLabelText("settings.tab.attachmentStorageBucket")).not.toBeInTheDocument();
    expect(screen.queryByText("common.save")).not.toBeInTheDocument();
  });

  it("saves only the flag when the switch is the one change", async () => {
    const onUpdate = vi.fn();
    renderWithProvider(<AttachmentStorageCard instance={makeInstance()} onUpdate={onUpdate} />);

    await userEvent.click(screen.getByLabelText("settings.tab.attachmentStorage"));
    await userEvent.click(screen.getByText("common.save"));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("a1", { attachmentStorageEnabled: true });
    });
    expect(mockSecretsSet).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalled();
  });

  it("writes the bucket and its keys before turning storage on", async () => {
    const { container } = renderWithProvider(<AttachmentStorageCard instance={makeInstance()} onUpdate={vi.fn()} />);

    await userEvent.click(screen.getByLabelText("settings.tab.attachmentStorage"));
    await userEvent.type(screen.getByLabelText("settings.tab.attachmentStorageBucket"), "acme-files");
    await userEvent.type(screen.getByLabelText("settings.tab.awsRegion"), "eu-south-1");
    // The two keys are masked inputs, in the order the card shows them.
    const [keyId, secret] = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="password"]'));
    await userEvent.type(keyId!, "AKIAEXAMPLE");
    await userEvent.type(secret!, "example-secret");
    await userEvent.click(screen.getByText("common.save"));

    await waitFor(() => expect(calls).toContain("flag"));
    expect(calls).toEqual([
      "secret:s3_bucket_name",
      "secret:aws_region",
      "secret:aws_access_key_id",
      "secret:aws_secret_access_key",
      "flag",
    ]);
  });

  it("leaves storage off when a key fails to save", async () => {
    mockSecretsSet.mockRejectedValueOnce(new Error("nope"));
    renderWithProvider(<AttachmentStorageCard instance={makeInstance()} onUpdate={vi.fn()} />);

    await userEvent.click(screen.getByLabelText("settings.tab.attachmentStorage"));
    await userEvent.type(screen.getByLabelText("settings.tab.attachmentStorageBucket"), "acme-files");
    await userEvent.click(screen.getByText("common.save"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});
