// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

import type {
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
} from "@zcode/shared/zcode-protocol-v4";

import {
  v4AttachmentAbortParamsSchema,
  v4AttachmentBeginParamsSchema,
  v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
/** begin 只 admission metadata，不解码/暂存 full payload。 */

export async function attachmentBegin(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4AttachmentBeginResult> {
  const params = v4AttachmentBeginParamsSchema.parse(rawParams);
  if (!this.host.putSessionAttachment) {
    throw new Error("fault.attachment.putUnsupported");
  }
  if (!this.host.sessionExists(params.sessionId)) {
    await this.coldResume.ensureResumed(params.sessionId);
  }
  return this.attachmentUploads.begin(params);
}

export async function attachmentChunk(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4AttachmentChunkResult> {
  return this.attachmentUploads.chunk(v4AttachmentChunkParamsSchema.parse(rawParams));
}

export function attachmentCommit(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4AttachmentCommitResult> {
  return this.attachmentUploads.commit(v4AttachmentCommitParamsSchema.parse(rawParams));
}

export async function attachmentAbort(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<void> {
  await this.attachmentUploads.abort(v4AttachmentAbortParamsSchema.parse(rawParams));
}
