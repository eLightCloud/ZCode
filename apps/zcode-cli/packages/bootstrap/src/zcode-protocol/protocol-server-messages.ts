import { normalizeStoredTitleSource } from "./v4-bridge-session-facts.js";
import { networkCaptureControlSchema } from "@zcode/shared";
import { runtimeMaintenanceParamsSchema } from "@zcode/shared";
import { conversationCheckpointParamsSchema } from "@zcode/shared";
import { TextCheckpointError, type SessionId } from "@zcode/contracts";
import { resolve } from "node:path";

import { zcodeProtocolMethods } from "@zcode/shared";

import type {
  ZCodeProtocolError,
  ZCodeProtocolMessage,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
  ZCodeProtocolResponse,
} from "@zcode/shared";

import {
  ProtocolRequestError,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  toProtocolError,
} from "./server-types.js";

import { collectResidencySessionIds } from "./protocol-server-support.js";
import { checkpointIndexProjection } from "./checkpoint-index.js";
import { continuationControl, assertContinuationAdmission } from "./continuation-control.js";
import { continuationContent } from "./continuation-content.js";

import type { ZCodeProtocolAgentServerMethodsContext } from "./protocol-server-context.js";
export async function handleMessage(
  this: ZCodeProtocolAgentServerMethodsContext,
  message: ZCodeProtocolMessage,
): Promise<ZCodeProtocolError | ZCodeProtocolResponse | undefined> {
  this.runtimeResources.assertServing();
  if (isResponse(message)) {
    this.resolveClientRequest(message.id, message.result);
    return undefined;
  }
  if (isErrorResponse(message)) {
    this.rejectClientRequest(
      message.id,
      new ProtocolRequestError(message.error.code, message.error.message, message.error.data),
    );
    return undefined;
  }
  if (isRequest(message)) {
    return await this.handleRequest(message);
  }
  if (isNotification(message)) {
    if (message.method === zcodeProtocolMethods.processNetworkCapture) {
      const control = networkCaptureControlSchema.safeParse(message.params);
      if (control.success) this.networkCapture.setCaptureId(control.data.captureId);
      return undefined;
    }
    this.logger?.debug("ZCode Protocol notification ignored", {
      event: "zcode_protocol.notification.ignored",
      method: message.method,
      module: "bootstrap.zcode_protocol",
    });
  }
  return undefined;
}

export async function handleRequest(
  this: ZCodeProtocolAgentServerMethodsContext,
  request: ZCodeProtocolRequest,
): Promise<ZCodeProtocolError | ZCodeProtocolResponse> {
  // request id 可在前一请求完成后复用；新请求不能继承未消费的旧 outbox。
  this.postResponseOutbox.delete(request.id);
  let releaseResidencyOperation: (() => void) | undefined;
  try {
    if (request.method === zcodeProtocolMethods.sessionContinuation)
      return this.ok(request.id, await continuationControl(this.context, request.params));
    if (request.method === zcodeProtocolMethods.sessionContinuationContent)
      return this.ok(request.id, await continuationContent(this.context, request.params));
    // 生命周期命令自身不能取得普通 operation lease，否则永远将自己判为忙。
    if (request.method === zcodeProtocolMethods.processIdleMaintenance) {
      if (!this.context.sessionResidentPool) throw new Error("Runtime lifecycle unavailable");
      return this.ok(
        request.id,
        await this.context.sessionResidentPool.maintenance(
          runtimeMaintenanceParamsSchema.parse(request.params),
        ),
      );
    }
    if (
      request.method === zcodeProtocolMethods.sessionTextCheckpoint ||
      request.method === zcodeProtocolMethods.sessionTextCheckpointIndex
    ) {
      const { sessionId } = conversationCheckpointParamsSchema.parse(request.params);
      const pool = this.context.sessionResidentPool;
      const store = this.context.deps.sessionStore;
      if (!pool || !store?.exportTextCheckpoint)
        throw new ProtocolRequestError(-32000, "Checkpoint unavailable");
      if (
        request.method === zcodeProtocolMethods.sessionTextCheckpointIndex &&
        this.context.sessions.has(sessionId)
      )
        throw new TextCheckpointError("unsupported_state");
      const directory = this.context.deps.cwd ?? process.cwd();
      const { checkpoint, cliFacts } = await pool.withCheckpoint(sessionId, async () => {
        const stored = await store.getSession(sessionId as SessionId);
        if (!stored) throw new TextCheckpointError("session_not_found");
        // tasks 库丢失后不能仅凭全局 session ID 把目录项目补成普通会话。
        if (stored.workspaceID || resolve(stored.directory) !== resolve(directory))
          throw new TextCheckpointError("unsupported_state");
        const checkpoint = await store.exportTextCheckpoint!({ sessionID: sessionId as SessionId });
        const current = await store.getSession(sessionId as SessionId);
        if (
          !current ||
          current.workspaceID ||
          resolve(current.directory) !== resolve(directory) ||
          current.title !== checkpoint.session.title ||
          current.time.created !== checkpoint.session.time.created ||
          current.time.updated !== checkpoint.session.time.updated
        )
          throw new TextCheckpointError("unsupported_state");
        return {
          checkpoint,
          cliFacts: {
            titleSource: normalizeStoredTitleSource(current.titleSource),
            ...(current.lastOutcome ? { lastOutcome: current.lastOutcome } : {}),
            deleted: current.time.deleted !== undefined,
          },
        };
      });
      this.logger?.info("Native checkpoint captured", {
        event: "conversation.sync.capture",
        sessionId,
        outcome: "saved",
      });
      return this.ok(request.id, {
        dataBase64: Buffer.from(JSON.stringify(checkpoint)).toString("base64"),
        ...(request.method === zcodeProtocolMethods.sessionTextCheckpointIndex
          ? { indexProjection: checkpointIndexProjection(checkpoint, directory, cliFacts) }
          : {}),
      });
    }
    // subscribe hydration、workspace 配置与 resume 都可能跨 await。若只看
    // session 当前状态，sampler 会在 handler 持有旧 record 时把它关闭。进程级 lease
    // 覆盖整个 request；能识别的 sessionIds 额外用于冷恢复闸门与 LRU touch。
    await assertContinuationAdmission(
      this.context,
      request.method,
      request.params,
      collectResidencySessionIds(request.params),
    );
    releaseResidencyOperation = await this.context.sessionResidentPool?.acquireOperation(
      collectResidencySessionIds(request.params),
    );
    const result = await this.dispatchRequest(request);
    return this.ok(request.id, result);
  } catch (error) {
    this.postResponseOutbox.delete(request.id);
    const protocolError = toProtocolError(error);
    return this.fail(request.id, protocolError.code, protocolError.message, protocolError.data);
  } finally {
    releaseResidencyOperation?.();
  }
}

export function requireV4Gateway(
  this: ZCodeProtocolAgentServerMethodsContext,
): NonNullable<ZCodeProtocolAgentServerMethodsContext["context"]["v4Gateway"]> {
  if (!this.context.v4Gateway) {
    throw new ProtocolRequestError(-32603, "v4 gateway is not initialized");
  }
  return this.context.v4Gateway;
}

export function ok(
  this: ZCodeProtocolAgentServerMethodsContext,
  id: ZCodeProtocolRequestId,
  result: unknown,
): ZCodeProtocolResponse {
  return { id, result };
}

export function fail(
  this: ZCodeProtocolAgentServerMethodsContext,
  id: ZCodeProtocolRequestId,
  code: number,
  message: string,
  data?: unknown,
): ZCodeProtocolError {
  return { error: { code, data, message }, id };
}
