// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

import { extractMarkdownArtifactImageRefs } from "@zcode/shared";

import type {
  AttachmentRef,
  V4AttachmentPreviewSourceResult,
} from "@zcode/shared/zcode-protocol-v4";

import {
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
} from "@zcode/shared/zcode-protocol-v4";

import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

import { artifactRefBelongsToSession } from "./gateway-support.js";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
export async function attachmentPreviewSource(
  this: ConversationV4GatewayMethodsContext,
  rawParams: unknown,
): Promise<V4AttachmentPreviewSourceResult> {
  const params = v4AttachmentPreviewSourceParamsSchema.parse(rawParams);
  const existingReady = this.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !this.host.sessionExists(params.sessionId)
      ? await this.ensureColdReadyPublisher(params.sessionId)
      : await this.hydratePublisher(params.sessionId);
  const resolution = this.resolveReadableMediaAttachment(
    publisher,
    params.sessionId,
    params.ref,
    params.target,
    params.attachmentIndex,
  );
  if (!resolution) {
    throw new Error("fault.attachment.previewRefNotAuthorized");
  }
  if (
    params.clientMode !== "desktop-continuous" ||
    !resolution.attachment.mime.startsWith("video/") ||
    !this.host.resolveSessionAttachmentPreviewSource
  ) {
    return { kind: "chunked" };
  }
  const result = await this.host.resolveSessionAttachmentPreviewSource(params.sessionId, {
    ref: params.ref,
    mime: resolution.attachment.mime,
    ...(resolution.messageId ? { messageId: resolution.messageId } : {}),
    ...(resolution.attachmentIndex !== undefined
      ? { attachmentIndex: resolution.attachmentIndex }
      : {}),
  });
  return v4AttachmentPreviewSourceResultSchema.parse(result);
}

export function resolveReadableMediaAttachment(
  this: ConversationV4GatewayMethodsContext,
  publisher: ConversationTopicPublisher,
  sessionId: string,
  ref: string,
  target?: { rowId: number; entityId: string },
  attachmentIndex?: number,
): { attachment: AttachmentRef; messageId?: string; attachmentIndex?: number } | null {
  const isPreviewable = (attachment: AttachmentRef) => {
    const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    // 根因：原预览仅放行图片、视频和 PDF，文本附件即使归属当前行也被拒绝。
    // 文本只开放既有材料标记，后续仍须通过权威行、附件索引和 ref 的归属校验。
    return (
      mime.startsWith("image/") ||
      mime.startsWith("video/") ||
      mime === "application/pdf" ||
      (mime === "text/plain" &&
        (attachment.sourceKind === "topic-history" || attachment.sourceKind === "clipboard-text"))
    );
  };
  const matchesRef = (attachment: AttachmentRef) =>
    attachment.ref === ref || attachment.previewRef === ref;
  if (target && attachmentIndex !== undefined) {
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) => candidate.rowId === target.rowId && candidate.entityId === target.entityId,
      );
    if (row?.kind !== "userInput") return null;
    const attachment = row.attachments?.[attachmentIndex];
    if (!attachment || !isPreviewable(attachment) || !matchesRef(attachment)) {
      return null;
    }
    // 热态 renderer 可能还持有 original ref，而 hydrate 后的权威 row 已补
    // previewRef；两者属于同一个 row/index，授权不能因投影时序不同而误判为跨行读取。
    const messageId = publisher.getMessageIdForRow(row.rowId);
    return {
      attachment,
      attachmentIndex,
      ...(messageId ? { messageId } : {}),
    };
  }

  // 旧 renderer 没有 row target，无法按消息定位持久 artifact；一旦
  // previewRef 存在就只能授权该 durable ref，不能重新放行可变的原始路径。
  for (const row of publisher.getSnapshot().rows.window) {
    if (row.kind === "userInput") {
      for (const attachment of row.attachments ?? []) {
        if (!isPreviewable(attachment)) continue;
        if ((attachment.previewRef ?? attachment.ref) === ref) return { attachment };
      }
    }
    if (
      row.kind === "assistantText" &&
      artifactRefBelongsToSession(ref, sessionId) &&
      extractMarkdownArtifactImageRefs(row.text).includes(ref)
    ) {
      // assistant Markdown 可以引用工具产出的 session artifact，
      // 但旧授权只查看 userInput.attachments，导致合法图片到 UI 后被 harden
      // 拦截。仍以当前 session 的权威投影做精确 ref 授权，绝不接受 renderer
      // 自报的任意 artifact/path。Markdown 是模型可控文本，所以 URI authority
      // 还必须与当前请求 session 精确匹配；仅“当前投影里出现过”不能证明它有权
      // 读取另一个 session 的 artifact。
      return {
        attachment: {
          ref,
          fileName: "assistant-image",
          mime: "image/*",
          bytes: 0,
        },
      };
    }
  }
  return null;
}
