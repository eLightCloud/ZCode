// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePluginUninstall } from "@/settings/usePluginUninstall.js";

const mocks = vi.hoisted(() => ({
  before: vi.fn(),
  uninstall: vi.fn(),
  after: vi.fn(),
  toast: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@/root/ApplicationPluginStoreSection.js", () => ({
  useApplicationPluginStoreSection: () => ({ beforeUninstall: mocks.before }),
}));
vi.mock("@/i18n/index.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));
vi.mock("@/logger.js", () => ({ logger: { warn: mocks.warn } }));
vi.mock("@/store/pluginManagementStore.js", () => ({
  usePluginManagementStore: Object.assign(
    (select: (state: unknown) => unknown) => select({ uninstallPlugin: mocks.uninstall }),
    { getState: () => ({ error: null }) },
  ),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function hook() {
  return renderHook(() =>
    usePluginUninstall({
      pluginService: {} as never,
      installedPlugins: [],
      plugins: [],
      activeOperations: [],
      onAfterUninstall: mocks.after,
    }),
  );
}
it("cancels the existing synchronization intent before the native uninstall", async () => {
  const order: string[] = [];
  mocks.before.mockImplementation(async () => {
    order.push("selection");
  });
  mocks.uninstall.mockImplementation(async () => {
    order.push("native");
  });
  const { result } = hook();
  act(() => result.current.requestUninstall("synthetic@hosted"));
  await act(async () => {
    await result.current.confirmUninstall();
  });
  expect(order).toEqual(["selection", "native"]);
  expect(mocks.after).toHaveBeenCalledOnce();
});
it("keeps the package and reports a retry when intent cancellation fails", async () => {
  mocks.before.mockRejectedValueOnce(new Error("synthetic unavailable"));
  const { result } = hook();
  act(() => result.current.requestUninstall("synthetic@hosted"));
  await act(async () => {
    await result.current.confirmUninstall();
  });
  expect(mocks.uninstall).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledOnce();
  expect(mocks.after).not.toHaveBeenCalled();
});
