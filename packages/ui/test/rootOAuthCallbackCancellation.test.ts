import { describe, expect, it, vi } from "vitest";

const { effects, errorLog } = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>,
  errorLog: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => unknown) => effects.push(effect),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@/hooks/useAlertDialog.js", () => ({ useAlertDialog: () => vi.fn() }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: () => "登录失败" } }),
}));
vi.mock("@/root/useAccountConnectionLossNotification.js", () => ({
  useAccountConnectionLossNotification: vi.fn(),
}));
vi.mock("@/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: errorLog },
}));
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";

describe("失效 OAuth 回调", () => {
  it("application-owned account skips native credentials but announces renderer readiness", () => {
    effects.length = 0;
    const nativeRestore = vi.fn();
    const nativeCallback = vi.fn();
    const nativeBroadcast = vi.fn();
    const notifyRendererReady = vi.fn();
    const setUser = vi.fn();
    const setRestoring = vi.fn();
    useRootOAuthEffects({
      enabled: false,
      accountIntentKey: "application-account",
      platform: { onOAuthCallback: nativeCallback, notifyRendererReady } as never,
      services: {
        oauthService: { restoreCachedSessionState: nativeRestore },
        broadcastService: { onMessage: nativeBroadcast },
      } as never,
      refreshProviderState: vi.fn(),
      setUser,
      setIsRestoringOAuthSession: setRestoring,
      setOAuthError: vi.fn(),
      oauthPollingActive: true,
      setOAuthPollingActive: vi.fn(),
      markOAuthSuccess: vi.fn(),
      onReauthenticationRequired: vi.fn(),
    });
    const cleanup = effects.map((effect) => effect());
    expect(nativeRestore).not.toHaveBeenCalled();
    expect(nativeCallback).not.toHaveBeenCalled();
    expect(nativeBroadcast).not.toHaveBeenCalled();
    expect(setUser).not.toHaveBeenCalled();
    expect(setRestoring).toHaveBeenCalledWith(false);
    expect(notifyRendererReady).toHaveBeenCalledTimes(1);
    for (const dispose of cleanup) if (typeof dispose === "function") dispose();
  });
  it.each([true, false])("pollingActive=%s 时静默忽略取消结果", async (oauthPollingActive) => {
    effects.length = 0;
    errorLog.mockClear();
    let callback!: (url: string) => Promise<void>;
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const markOAuthSuccess = vi.fn();
    const setOAuthPollingActive = vi.fn();
    useRootOAuthEffects({
      accountIntentKey: "test",
      platform: {
        notifyRendererReady: vi.fn(),
        onOAuthCallback: (handler: typeof callback) => {
          callback = handler;
          return vi.fn();
        },
      } as never,
      services: {
        oauthService: { handleCallback: vi.fn(async () => null) },
        broadcastService: {},
      } as never,
      refreshProviderState: vi.fn(async () => {}),
      setUser,
      setIsRestoringOAuthSession: vi.fn(),
      setOAuthError,
      oauthPollingActive,
      setOAuthPollingActive,
      markOAuthSuccess,
      onReauthenticationRequired: vi.fn(),
    });
    // 只挂载回调订阅；启动恢复和轮询在各自测试中验证。
    effects.at(-1)!();
    await callback("zcode://oauth/callback?state=cancelled");
    expect(errorLog).not.toHaveBeenCalled();
    expect(setUser).not.toHaveBeenCalled();
    expect(setOAuthError).not.toHaveBeenCalled();
    expect(markOAuthSuccess).not.toHaveBeenCalled();
    expect(setOAuthPollingActive).not.toHaveBeenCalled();
  });
});
