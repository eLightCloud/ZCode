import type { IApplicationHostService, IZCodeAgentService } from "@zcode/services";

type Preparation = (
  input: {
    workspacePath: string;
    workspaceIdentity?: string;
    commandId: string;
    sessionId?: string;
    signal: AbortSignal;
    reportStage: (stage: string) => void;
  },
  host?: IApplicationHostService,
) => Promise<void>;
/** Explicit policy rejection is different from optional binding transport failure. */
export class ApplicationInputRejected extends Error {
  constructor(
    readonly code: string,
    message = code,
    readonly stage?: string,
    readonly reason?: "timeout" | "cancelled" | "failed",
  ) {
    super(message);
    this.name = "ApplicationInputRejected";
  }
}
let preparation: Preparation | undefined;
let required = false;
let optionalPreparation: Preparation | undefined;
let generation = 0;
const waiting = new Set<AbortController>();

/** Trusted application startup only. Never modifies the native command or its identity. */
export function setApplicationInputPreparation(
  value: Preparation | undefined,
  options?: { required?: boolean; optional?: Preparation },
): void {
  preparation = value;
  required = options?.required === true;
  optionalPreparation = options?.optional;
  generation += 1;
  // 账号代次由注册 owner 唯一持有；撤销不能让旧等待返回成功并继续发送。
  for (const abort of waiting) abort.abort("cancelled");
}
export async function prepareApplicationInput(
  params: Parameters<IZCodeAgentService["sendConversationCommandV4"]>[0],
  host?: IApplicationHostService,
): Promise<void> {
  if (
    !preparation ||
    !["sendText", "createSession", "sendGoalCommand"].includes(params.envelope.type)
  )
    return;
  const mandatory = required;
  const prepare = preparation;
  const observe = optionalPreparation;
  const startedGeneration = generation;
  const abort = new AbortController();
  waiting.add(abort);
  let admitted = false;
  let stage = "application_preparation";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const rejection = (reason: "timeout" | "cancelled" | "failed") =>
    new ApplicationInputRejected("application_input_unconfirmed", undefined, stage, reason);
  const assertCurrent = () => {
    if (startedGeneration !== generation || abort.signal.aborted) throw rejection("cancelled");
  };
  const input = {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    commandId: params.envelope.commandId,
    sessionId: params.envelope.sessionId ?? undefined,
    signal: abort.signal,
    reportStage: (value: string) => {
      if (!abort.signal.aborted && /^[a-z][a-z0-9_]{0,63}$/.test(value)) stage = value;
    },
  };
  try {
    // 强制归属与可选观察共享原有预算，只有强制阶段确认后才允许观察超时放行。
    const interrupted = new Promise<void>((resolve, reject) => {
      onAbort = () => {
        if (abort.signal.reason === "timeout" && (!mandatory || admitted)) resolve();
        else reject(rejection(abort.signal.reason === "timeout" ? "timeout" : "cancelled"));
      };
      abort.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => abort.abort("timeout"), 5000);
    });
    await Promise.race([
      (async () => {
        await prepare(input, host);
        assertCurrent();
        admitted = true;
        if (observe) {
          try {
            await observe(input, host);
          } catch (error) {
            if (error instanceof ApplicationInputRejected) throw error;
          }
        }
      })(),
      interrupted,
    ]);
    if (startedGeneration !== generation) throw rejection("cancelled");
  } catch (error) {
    // 已确认的禁入必须保留草稿；可选绑定网络失败仍不接管原生接纳。
    if (error instanceof ApplicationInputRejected)
      throw error.stage
        ? error
        : new ApplicationInputRejected(error.code, error.message, stage, error.reason ?? "failed");
    // Web 强制准备失败不能伪装成可选本地绑定，未知结果保留草稿供原操作重查。
    if (mandatory)
      throw rejection(
        error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "failed",
      );
    // 应用自己投影保存失败，原生只保留原命令及 admission owner。
  } finally {
    clearTimeout(timer);
    if (onAbort) abort.signal.removeEventListener("abort", onAbort);
    waiting.delete(abort);
    abort.abort();
  }
}
