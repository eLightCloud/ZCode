// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。

import type { ConversationV4GatewayMethodsContext } from "./gateway-context.js";
import type { BinaryReadCacheEntry } from "./gateway-support.js";
/**
 * 一个产物版本的**整份**字节，带缓存。
 *
 * 端口的 `readArtifact` 返回的是整份字节，而
 * `workflowRunArtifactRead` 是**分块**查询——不缓存的话，一个 20 MiB 的 PDF 按 512 KiB
 * 分 40 块取，就会把整份文件从 store 读 40 遍（800 MiB 的 I/O），而且每一块都要重走一遍
 * journal 授权链。`attachmentRead` 早就有这张表，这里复用它（见 {@link BinaryReadCacheEntry}
 * 关于两个家族共用一张表的论证）。
 *
 * 缓存的是 **promise 而不是结果**，且在发起前就写进表里：并发抓取的多个分块因此共享
 * 同一次读，而不是各自发起一次再各自写一遍缓存。
 *
 * 授权不因缓存被绕过：键里带着 `sessionId`，而 `sessionId` 正是端口那条授权链
 * （run 的 parentSessionId 必须等于它）的比对对象——换一个会话就是另一个键，必然重新
 * 走一次端口。会话销毁时按 `sessionId` 整片清掉，与附件同一条规则。
 *
 * 宿主回 `undefined`（不是你的 run / 无此版本 / 是块看板）在这里**抛错**而不是被缓存：
 * 走既有的 catch 分支把条目删掉，于是一个"发布刚落库、读稍微早了一步"的竞态不会被
 * 负缓存钉死 30 秒。
 */

export function readWorkflowArtifactPayload(
  this: ConversationV4GatewayMethodsContext,
  params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  },
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const now = this.now();
  this.pruneBinaryReadCache(now);
  // 首段标签 `dwfart`：与附件预览共用同一张表，靠首段隔离（见 BinaryReadCacheEntry）。
  const key = `dwfart\u0000${params.sessionId}\u0000${params.runId}\u0000${params.artifactId}\u0000${params.version}`;
  const cached = this.binaryReadCache.get(key);
  if (cached) {
    cached.accessedAt = now;
    return cached.payload;
  }

  const payload = this.host.readDynamicWorkflowRunArtifact!(params.sessionId, {
    runId: params.runId,
    artifactId: params.artifactId,
    version: params.version,
  })
    .then((artifact) => {
      if (artifact === undefined) {
        throw new Error(
          `fault.workflowRunArtifactRead.notFound: ${params.runId}/${params.artifactId}@${params.version}`,
        );
      }
      const current = this.binaryReadCache.get(key);
      if (current) {
        current.bytes = artifact.bytes.byteLength;
        this.binaryReadCacheBytes += artifact.bytes.byteLength;
        this.pruneBinaryReadCache(this.now());
      }
      // contentType 归一成表里的 mediaType 词汇；值仍是 journal 记录上的那一份
      // （UI 分派渲染器的精确匹配契约），不是 store 按文件名再推的那个。
      return { bytes: artifact.bytes, mediaType: artifact.contentType };
    })
    .catch((error: unknown) => {
      this.deleteBinaryReadCacheEntry(key);
      throw error;
    });
  this.binaryReadCache.set(key, {
    sessionId: params.sessionId,
    accessedAt: now,
    bytes: null,
    payload,
  });
  return payload;
}
