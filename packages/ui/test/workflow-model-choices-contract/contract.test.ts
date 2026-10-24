// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
const owned = vi.hoisted(() => ({
  read: vi.fn(() => ({ state: { status: "loading" }, reload: vi.fn() })),
}));
vi.mock("@/hooks/useModelSelectionView.js", () => ({ useModelSelectionView: owned.read }));
vi.mock("@/root/ApplicationSettings.js", () => ({ useApplicationSettings: () => undefined }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
import { useWorkflowSettingsModelChoices } from "../../src/workflow-model-choices/contract.js";
afterEach(() => cleanup());
it("keeps a pending catalog unavailable and carries the full native scope to its existing reader", () => {
  const { result } = renderHook(() =>
    useWorkflowSettingsModelChoices({
      workspacePath: "/owned-workspace",
      workspaceIdentity: "owned-identity",
      remoteSessionId: "owned-session",
    }),
  );
  expect(result.current.loading).toBe(true);
  expect(result.current.noCatalog).toBe(false);
  expect(result.current.groups).toEqual([]);
  expect(owned.read).toHaveBeenCalledWith("/owned-workspace", "owned-session", "owned-identity");
});
