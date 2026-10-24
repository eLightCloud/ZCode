import type { IApplicationHostService, IZCodeAgentService } from "@zcode/services";

type Preparation = (
  input: {
    workspacePath: string;
    workspaceIdentity?: string;
    commandId: string;
    sessionId?: string;
    signal: AbortSignal;
  },
  host?: IApplicationHostService,
) => Promise<void>;
/** Explicit policy rejection is different from optional binding transport failure. */
export class ApplicationInputRejected extends Error {
  constructor(readonly code: string, message=code) { super(message); this.name="ApplicationInputRejected"; }
}
let preparation: Preparation | undefined;
let required=false;

/** Trusted application startup only. Never modifies the native command or its identity. */
export function setApplicationInputPreparation(value: Preparation | undefined, options?:{required?:boolean}): void {
  preparation = value;required=options?.required===true;
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
  const mandatory=required;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 可选应用接合不能无限阻塞原生命令；取消信号同时阻止迟到的身份绑定。
    await Promise.race([
      preparation(
        {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          commandId: params.envelope.commandId,
          sessionId: params.envelope.sessionId ?? undefined,
          signal: abort.signal,
        },
        host,
      ),
      new Promise<void>((resolve,reject) => {
        timer = setTimeout(() => {
          abort.abort();
          if(mandatory) reject(new ApplicationInputRejected("application_input_unconfirmed")); else resolve();
        }, 5000);
      }),
    ]);
  } catch (error) {
    // 已确认的禁入必须保留草稿；可选绑定网络失败仍不接管原生接纳。
    if (error instanceof ApplicationInputRejected) throw error;
    // 应用自己投影保存失败，原生只保留原命令及 admission owner。
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
