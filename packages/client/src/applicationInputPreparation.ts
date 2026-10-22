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
let preparation: Preparation | undefined;

/** Trusted application startup only. Never modifies the native command or its identity. */
export function setApplicationInputPreparation(value: Preparation | undefined): void {
  preparation = value;
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
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve();
        }, 5000);
      }),
    ]);
  } catch {
    // 应用自己投影保存失败，原生只保留原命令及 admission owner。
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
