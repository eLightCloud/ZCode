// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
} from "@zcode/shared/zcode-protocol-v4";

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
/**
 * 读取附件全部字节（带 TTL/容量缓存）。
 *
 * 注意语义：conversationAttachmentRead 的 offset/limit 是**切片**，不是流式读取——
 * 每个首次请求都会把整个附件物化进内存再切片，后续 chunk 命中同一份缓存。
 * 接入方不要把 chunk 协议当作「按需分段拉取」来规划超大文件；真正的 range 读取
 * 需要 host 侧 readBinaryFile 支持 offset（尚未实现）。
 */

export function readAttachmentPayload(
  this: ConversationV4GatewayMethodsContext,
  sessionId: string,
  ref: string,
  mime: string,
  messageId?: string,
  attachmentIndex?: number,
  allowGeneric = false,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const now = this.now();
  this.pruneBinaryReadCache(now);
  // 首段标签 `att`：这张表与 dwf 产物字节共用（见 BinaryReadCacheEntry），两个键空间
  // 只能靠一个不可能相等的首段隔离。
  const key = `att\u0000${sessionId}\u0000${messageId ?? "legacy"}\u0000${attachmentIndex ?? -1}\u0000${ref}`;
  const cached = this.binaryReadCache.get(key);
  if (cached) {
    cached.accessedAt = now;
    return cached.payload;
  }

  // 预览读取曾复用上传的 20MiB 总量上限；video 使用已有全局输入上限，
  // image 和上传事务继续保持原边界。
  const maxBytes = allowGeneric
    ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
    : mime.startsWith("video/")
      ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
      : PROTOCOL_V4_LIMITS.attachmentMaxBytes;
  const payload = this.host.readSessionAttachment!(sessionId, {
    ref,
    mime,
    maxBytes,
    ...(messageId ? { messageId } : {}),
    ...(attachmentIndex !== undefined ? { attachmentIndex } : {}),
  })
    .then((result) => {
      const resultMime = result.mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (
        !allowGeneric &&
        !resultMime.startsWith("image/") &&
        !resultMime.startsWith("video/") &&
        resultMime !== "application/pdf" &&
        !(
          resultMime === "text/plain" &&
          mime.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
        )
      ) {
        throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewNotMedia);
      }
      if (result.bytes.byteLength > maxBytes) {
        throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge);
      }
      const current = this.binaryReadCache.get(key);
      if (current) {
        current.bytes = result.bytes.byteLength;
        this.binaryReadCacheBytes += result.bytes.byteLength;
        this.pruneBinaryReadCache(this.now());
      }
      return result;
    })
    .catch((error) => {
      this.deleteBinaryReadCacheEntry(key);
      throw error;
    });
  this.binaryReadCache.set(key, { sessionId, accessedAt: now, bytes: null, payload });
  return payload;
}

export function pruneBinaryReadCache(
  this: ConversationV4GatewayMethodsContext,
  now = this.now(),
): void {
  for (const [key, entry] of this.binaryReadCache) {
    if (now - entry.accessedAt > PROTOCOL_V4_LIMITS.attachmentReadCacheTtlMs) {
      this.deleteBinaryReadCacheEntry(key);
    }
  }
  if (this.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) return;
  const oldest = [...this.binaryReadCache.entries()]
    .filter(([, entry]) => entry.bytes !== null)
    .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
  for (const [key] of oldest) {
    this.deleteBinaryReadCacheEntry(key);
    if (this.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) break;
  }
}

export function deleteBinaryReadCacheEntry(
  this: ConversationV4GatewayMethodsContext,
  key: string,
): void {
  const entry = this.binaryReadCache.get(key);
  if (!entry) return;
  this.binaryReadCache.delete(key);
  this.binaryReadCacheBytes = Math.max(0, this.binaryReadCacheBytes - (entry.bytes ?? 0));
}
