import { networkCaptureControlSchema } from "@zcode/shared";

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
    // subscribe hydration、workspace 配置与 resume 都可能跨 await。若只看
    // session 当前状态，sampler 会在 handler 持有旧 record 时把它关闭。进程级 lease
    // 覆盖整个 request；能识别的 sessionIds 额外用于冷恢复闸门与 LRU touch。
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

export function requireV4Gateway(this: ZCodeProtocolAgentServerMethodsContext) {
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
