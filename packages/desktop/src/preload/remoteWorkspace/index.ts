import {
  PlatformChannels,
  type RemoteTarget,
  type RemoteConnectionRuntimeLog,
  type RemoteSessionClosedEvent,
  type RemoteSessionReconnectedEvent,
} from "@zcode/shared";
import type { IpcRenderer } from "electron";
import type {
  BindRemoteWorkspaceSessionContextIpcResult,
  BindRemoteWorkspaceSessionContextResult,
} from "@zcode/shared";

function unwrapRemoteWorkspaceBindResult(
  result: BindRemoteWorkspaceSessionContextIpcResult,
): BindRemoteWorkspaceSessionContextResult {
  if (result.success) return result.result;
  // Bug 原因：ipcMain.handle 抛出的 Error 经过 Electron invoke 后不会保留自定义属性。
  // wire 使用结构化结果，preload 在可信边界恢复 renderer 需要的稳定错误语义。
  const error = new Error(result.error) as Error & { code?: string; retryable?: boolean };
  if (result.reasonCode) error.code = result.reasonCode;
  if (result.retryable !== undefined) error.retryable = result.retryable;
  throw error;
}

export function createRemoteWorkspacePreload(ipcRenderer: IpcRenderer) {
  return {
    connectRemote: (
      options: RemoteTarget,
      requestId?: string,
      context?: {
        workspacePath?: string;
        workspaceIdentity?: string;
        connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
        confirmSourceServerInstall?: boolean;
      },
    ) =>
      ipcRenderer.invoke(PlatformChannels.ConnectRemote, {
        target: options,
        requestId,
        ...(context ? context : {}),
      }),
    requestSourceSettingsAttachment: (sourceServerId: string) =>
      ipcRenderer.invoke(PlatformChannels.RequestSourceSettingsAttachment, {
        sourceServerId,
      }),
    cancelPendingRemoteConnection: (requestId?: string): Promise<void> =>
      ipcRenderer.invoke(PlatformChannels.CancelPendingRemoteConnection, {
        requestId,
      }),
    bindRemoteWorkspaceSessionContext: (context: {
      remoteSessionId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    }): Promise<BindRemoteWorkspaceSessionContextResult> =>
      ipcRenderer
        .invoke(PlatformChannels.BindRemoteWorkspaceSessionContext, context)
        .then((result: BindRemoteWorkspaceSessionContextIpcResult) =>
          unwrapRemoteWorkspaceBindResult(result),
        ),
    onRemoteConnectionLog: (callback: (entry: RemoteConnectionRuntimeLog) => void) => {
      const handler = (_event: unknown, payload: unknown) =>
        callback(payload as RemoteConnectionRuntimeLog);
      ipcRenderer.on(PlatformChannels.RemoteConnectionLog, handler);
      return () => ipcRenderer.removeListener(PlatformChannels.RemoteConnectionLog, handler);
    },
    /** 订阅当前窗口内远程 session 关闭事件，返回 disposer */
    onRemoteSessionClosed: (callback: (event: RemoteSessionClosedEvent) => void) => {
      const handler = (_event: unknown, payload: unknown) =>
        callback(payload as RemoteSessionClosedEvent);
      ipcRenderer.on(PlatformChannels.RemoteSessionClosed, handler);
      return () => ipcRenderer.removeListener(PlatformChannels.RemoteSessionClosed, handler);
    },
    /** 订阅 Source 自动重连后的 logical session 换代事件。 */
    onRemoteSessionReconnected: (callback: (event: RemoteSessionReconnectedEvent) => void) => {
      const handler = (_event: unknown, payload: unknown) =>
        callback(payload as RemoteSessionReconnectedEvent);
      ipcRenderer.on(PlatformChannels.RemoteSessionReconnected, handler);
      return () => ipcRenderer.removeListener(PlatformChannels.RemoteSessionReconnected, handler);
    },
  };
}
