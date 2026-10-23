import type { ZCodeProtocolRequestId } from "@zcode/shared";

import type { ZCodeProtocolAgentServerMethodsContext } from "./protocol-server-context.js";
import type {
  ZCodeProtocolOutboundMessage,
  ZCodeProtocolPostResponseBatch,
} from "./protocol-server-support.js";
export function setNotificationSink(
  this: ZCodeProtocolAgentServerMethodsContext,
  sink: (message: ZCodeProtocolOutboundMessage) => void,
): void {
  this.runtimeResources.assertServing();
  this.clientDisconnectError = undefined;
  this.messageSink = sink;
}

export function disconnectClient(this: ZCodeProtocolAgentServerMethodsContext, error: Error): void {
  this.networkCapture.setCaptureId(null);
  this.clientDisconnectError = error;
  // 连接关闭后反向请求已不可能收到响应，必须先结束 pending，
  // 否则正在物化 Session 的 handler 会阻塞 connection 的关闭流程。
  const pendingRequests = new Set(this.pendingClientRequests.values());
  for (const pending of pendingRequests) {
    this.cleanupClientRequest(pending);
    pending.reject(error);
  }
}

/** 进程资源关闭，不使用会删除产品会话/发布 session.removed 的 session/close。 */

export function shutdown(this: ZCodeProtocolAgentServerMethodsContext): Promise<void> {
  if (this.shutdownPromise) return this.shutdownPromise;
  this.shutdownPromise = this.runtimeResources.close();
  const error = new Error("ZCode Protocol runtime stopping");
  this.disconnectClient(error);
  this.messageSink = undefined;
  this.clearPostResponseMessages();
  for (const controller of this.pluginOperationControllers.values()) controller.abort(error);
  for (const controller of this.workspaceGenerateTextControllers.values()) controller.abort(error);
  for (const record of this.context.sessions.values()) {
    record.activeAbortController?.abort(error);
    try {
      record.unsubscribe?.();
    } catch {
      this.logger?.warn("Session unsubscribe failed during protocol shutdown", {
        event: "zcode_protocol.session.unsubscribe.failed",
      });
    }
  }
  return this.shutdownPromise;
}

/** app drain 有界结束后释放投影；即使某个 app.close 挂起也必须执行。 */

export function disposeProjections(this: ZCodeProtocolAgentServerMethodsContext): void {
  this.context.v4Gateway?.dispose();
  this.context.sessions.clear();
}

/** 一次性取走某 request 的 post-response messages；重复 take 返回空数组。 */

export function takePostResponseMessages(
  this: ZCodeProtocolAgentServerMethodsContext,
  requestId: ZCodeProtocolRequestId,
): ZCodeProtocolOutboundMessage[] {
  const batch = this.takePostResponseBatch(requestId);
  batch?.commit();
  return [...(batch?.messages ?? [])];
}

/** production NDJSON 取完整 batch；只有全部 write 成功后才调 commit。 */

export function takePostResponseBatch(
  this: ZCodeProtocolAgentServerMethodsContext,
  requestId: ZCodeProtocolRequestId,
): ZCodeProtocolPostResponseBatch | null {
  const batch = this.postResponseOutbox.get(requestId) ?? null;
  this.postResponseOutbox.delete(requestId);
  return batch;
}

/** connection close / server dispose 时释放尚未写出的 initial frame 引用。 */

export function clearPostResponseMessages(this: ZCodeProtocolAgentServerMethodsContext): void {
  this.postResponseOutbox.clear();
}
