// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import { useDraftSessionPrewarm } from "@/v4/composer/useDraftSessionPrewarm.js";
import { logger } from "@/logger.js";
import {
  getV4CommandFailureDiagnostics,
  recordV4CommandAck,
} from "@/v4/commandAckObservability.js";

vi.mock("@/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

const accepted = (sessionId: string): CommandAck => ({
  commandId: "create-test",
  status: "accepted",
  revisionAtDecision: 0,
  result: { type: "createSession", sessionId },
});
const privateMessage = "private-server-message /internal/path credential=private-value";

function fixture() {
  const pending: Array<{ resolve(value: CommandAck): void; reject(error: unknown): void }> = [];
  const dispatchCommand = vi.fn(async (type: string) => {
    if (type !== "createSession") return accepted("cleanup");
    return new Promise<CommandAck>((resolve, reject) => pending.push({ resolve, reject }));
  });
  const transportIdentity = {};
  const hook = renderHook(
    ({ version }) =>
      useDraftSessionPrewarm({
        enabled: true,
        workspaceKey: "/workspace",
        paneId: "failure-test",
        transportIdentity,
        invalidationVersion: version,
        dispatchCommand,
      }),
    { initialProps: { version: 0 } },
  );
  return { ...hook, pending, dispatchCommand };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  cleanup();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("草稿创建失败的安全诊断与代次隔离", () => {
  it("命令 ACK 诊断只记录安全准备信息，不泄露原异常", () => {
    const diagnostics = getV4CommandFailureDiagnostics(
      Object.assign(new Error(privateMessage), {
        name: "ApplicationInputRejected",
        code: "application_input_unconfirmed",
        stage: "conversation_bind_input",
        reason: "timeout",
      }),
    );
    recordV4CommandAck({ type: "createSession", status: "transport-error", ...diagnostics, at: 1 });
    const host = window as Window & { __zcodeV4CommandAcksE2E?: unknown[] };
    expect(host.__zcodeV4CommandAcksE2E?.at(-1)).toEqual({
      type: "createSession",
      status: "transport-error",
      reasonCode: "application_input_unconfirmed",
      source: "application-input",
      nativeDispatch: "not_started",
      stage: "conversation_bind_input",
      reason: "timeout",
      at: 1,
    });
    expect(JSON.stringify(host.__zcodeV4CommandAcksE2E)).not.toContain(privateMessage);
    expect(getV4CommandFailureDiagnostics(new Error(privateMessage))).toEqual({
      reasonCode: "transport_error",
      source: "transport",
    });
    delete host.__zcodeV4CommandAcksE2E;
  });

  it.each([
    {
      name: "准备超时",
      error: Object.assign(new Error(privateMessage), {
        name: "ApplicationInputRejected",
        code: "application_input_unconfirmed",
        stage: "conversation_bind_input",
        reason: "timeout",
      }),
      code: "application_input_unconfirmed",
      diagnostics: {
        source: "application-input",
        stage: "conversation_bind_input",
        reason: "timeout",
      },
    },
    {
      name: "明确拒绝",
      error: Object.assign(new Error(privateMessage), {
        name: "ApplicationInputRejected",
        code: "conversation_owner_elsewhere",
      }),
      code: "conversation_owner_elsewhere",
      diagnostics: { source: "application-input" },
    },
    {
      name: "非法诊断字段",
      error: Object.assign(new Error(privateMessage), {
        name: "ApplicationInputRejected",
        code: "application_input_unconfirmed",
        stage: privateMessage,
        reason: privateMessage,
      }),
      code: "application_input_unconfirmed",
      diagnostics: { source: "application-input" },
    },
    {
      name: "未知服务异常",
      error: Object.assign(new Error(privateMessage), { code: "application_input_unconfirmed" }),
      code: "create_session_failed",
      diagnostics: { source: "transport" },
    },
    {
      name: "非法错误码",
      error: Object.assign(new Error(privateMessage), {
        name: "ApplicationInputRejected",
        code: privateMessage,
      }),
      code: "create_session_failed",
      diagnostics: { source: "transport" },
    },
  ])("$name：首发等待者得到同一安全错误，不另发创建", async ({ error, code, diagnostics }) => {
    const { result, pending, dispatchCommand } = fixture();
    const first = result.current.waitForSession().catch((failure: unknown) => failure);
    const second = result.current.waitForSession().catch((failure: unknown) => failure);
    await act(async () => pending[0]!.reject(error));
    const failure = await first;
    expect(failure).toMatchObject({
      name: "DraftSessionCreationError",
      code,
      message: code,
      diagnostics,
    });
    expect(await second).toBe(failure);
    expect(JSON.stringify(failure)).not.toContain(privateMessage);
    expect(String(failure)).not.toContain(privateMessage);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(privateMessage);
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(result.current.binding).toBeNull();
  });

  it.each(["guard.sessionCreationDenied", privateMessage])(
    "ACK 拒绝保留 status，只透传安全 reasonCode：%s",
    async (reasonCode) => {
      const { result, pending, dispatchCommand } = fixture();
      const waiting = result.current.waitForSession().catch((failure: unknown) => failure);
      await act(async () => {
        pending[0]!.resolve({
          commandId: "create-test",
          status: "rejected",
          revisionAtDecision: 0,
          reasonCode,
        });
      });
      expect(await waiting).toMatchObject({
        code: reasonCode === privateMessage ? "create_session_failed" : reasonCode,
        diagnostics: { source: "command-ack", status: "rejected" },
      });
      expect(await waiting).not.toHaveProperty("diagnostics.nativeDispatch");
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(privateMessage);
      expect(dispatchCommand).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "conversation_owner_elsewhere",
    "conversation_original_owner_elsewhere",
    "conversation_sync_limit",
    "conversation_sync_blocked",
  ])("已确认拒绝 %s 不后台重试，仍允许用户显式重试", async (code) => {
    const { result, pending, dispatchCommand } = fixture();
    const failure = result.current.waitForSession().catch((error: unknown) => error);
    await act(async () => {
      pending[0]!.reject(
        Object.assign(new Error(code), { name: "ApplicationInputRejected", code }),
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(await failure).toMatchObject({ code, diagnostics: { nativeDispatch: "not_started" } });
    const retry = result.current.waitForSession();
    await act(async () => pending[1]!.resolve(accepted("explicit-retry")));
    expect((await retry).sessionId).toBe("explicit-retry");
    expect(dispatchCommand).toHaveBeenCalledTimes(2);
  });

  it.each([
    "application_input_unconfirmed",
    "conversation_effect_context_unconfirmed",
    "conversation_cloud_unconfirmed",
    "conversation_owner_elsewhere_pending",
  ])("尚未确认或未知码 %s 维持原有三次有界退避", async (code) => {
    const { pending, dispatchCommand } = fixture();
    for (const [attempt, delay] of [500, 1000, 2000, 10_000].entries()) {
      await act(async () => {
        pending[attempt]!.reject(
          Object.assign(new Error(code), { name: "ApplicationInputRejected", code }),
        );
      });
      await act(async () => vi.advanceTimersByTimeAsync(delay));
      expect(dispatchCommand).toHaveBeenCalledTimes(Math.min(attempt + 2, 4));
    }
  });

  it("显式重试成功后清除上一代失败，并继续合并当前代等待者", async () => {
    const { result, pending, dispatchCommand } = fixture();
    const failed = result.current.waitForSession().catch((error: unknown) => error);
    await act(async () => pending[0]!.reject(new Error(privateMessage)));
    expect(await failed).toMatchObject({ code: "create_session_failed" });
    const retry = result.current.waitForSession();
    const joined = result.current.waitForSession();
    await act(async () => pending[1]!.resolve(accepted("retry-session")));
    expect((await retry).sessionId).toBe("retry-session");
    expect(await joined).toBe(await retry);
    expect(dispatchCommand).toHaveBeenCalledTimes(2);
  });

  it("旧代次失败不能覆盖当前订阅或让旧提交跨代发送", async () => {
    const { result, rerender, pending, dispatchCommand } = fixture();
    const stale = result.current.waitForSession().catch((error: Error) => error);
    rerender({ version: 1 });
    const current = result.current.waitForSession();
    await act(async () => pending[0]!.reject(new Error(privateMessage)));
    expect(await stale).toMatchObject({ message: "草稿会话已切换，请重新发送" });
    await act(async () => pending[1]!.resolve(accepted("current-session")));
    expect((await current).sessionId).toBe("current-session");
    expect(dispatchCommand).toHaveBeenCalledTimes(2);
  });
});
