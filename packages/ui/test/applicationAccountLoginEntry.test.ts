import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  loginEntryRequest: null as { id: number; providerId?: string } | null,
  clearLoginEntryRequest: vi.fn(),
  markLoginEntryAttemptStatus: vi.fn(),
  alert: vi.fn(),
  log: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void) => state.effects.push(effect),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (select: (store: typeof state) => unknown) => select(state),
}));
vi.mock("@/hooks/useAlertDialog.js", () => ({ useAlertDialog: () => state.alert }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/logger.js", () => ({ logger: { info: state.log } }));
import { useApplicationAccountLoginEntry } from "@/root/useApplicationAccountLoginEntry.js";
beforeEach(() => {
  vi.clearAllMocks();
  state.effects.length = 0;
  state.loginEntryRequest = null;
});
describe("application account and native cloud login", () => {
  it.each([undefined, "bigmodel"])(
    "settles and explains unsupported request; provider=%s",
    (providerId) => {
      state.loginEntryRequest = { id: 17, providerId };
      useApplicationAccountLoginEntry(true);
      state.effects[0]!();
      state.effects[0]!();
      expect(state.markLoginEntryAttemptStatus).toHaveBeenCalledExactlyOnceWith(17, "failed");
      expect(state.clearLoginEntryRequest).toHaveBeenCalledExactlyOnceWith(17);
      expect(state.alert).toHaveBeenCalledOnce();
      expect(state.alert.mock.calls[0]![0].description).toBe(
        "application.account.cloudUnavailableDescription",
      );
    },
  );
  it("leaves native login untouched without application admission", () => {
    state.loginEntryRequest = { id: 18, providerId: "bigmodel" };
    useApplicationAccountLoginEntry(false);
    state.effects[0]!();
    expect(state.clearLoginEntryRequest).not.toHaveBeenCalled();
    expect(state.markLoginEntryAttemptStatus).not.toHaveBeenCalled();
    expect(state.alert).not.toHaveBeenCalled();
  });
});
