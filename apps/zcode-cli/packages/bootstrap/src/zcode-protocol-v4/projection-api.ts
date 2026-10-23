// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）

import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";

import type {
  ConversationEditTarget,
  ConversationRowTargetResolution,
  StableForkCandidateResolution,
} from "./product-projection-contract.js";

import * as implementation1 from "./projection-action-targets.js";
import * as implementation0 from "./projection-configuration.js";
import * as implementation2 from "./projection-event-commit.js";
import * as implementation7 from "./projection-model-stream.js";
export interface ProductProjectionApi {
  seedConfig(...args: Parameters<typeof implementation0.seedConfig>): void;
  seedSharedContextImport(
    ...args: Parameters<typeof implementation0.seedSharedContextImport>
  ): void;
  seedUsage(...args: Parameters<typeof implementation0.seedUsage>): void;
  seedSubagents(...args: Parameters<typeof implementation0.seedSubagents>): void;
  resolveEditTarget(
    ...args: Parameters<typeof implementation1.resolveEditTarget>
  ): ConversationEditTarget | null;
  resolveEditTargetByEntityId(
    ...args: Parameters<typeof implementation1.resolveEditTargetByEntityId>
  ): ConversationEditTarget | null;
  resolveRowActionTarget(
    ...args: Parameters<typeof implementation1.resolveRowActionTarget>
  ): ConversationRowTargetResolution;
  getMessageIdsForTurnRow(
    ...args: Parameters<typeof implementation1.getMessageIdsForTurnRow>
  ): string[];
  isLatestAssistantSegmentRow(
    ...args: Parameters<typeof implementation1.isLatestAssistantSegmentRow>
  ): boolean;
  resolveStableForkCandidate(
    ...args: Parameters<typeof implementation1.resolveStableForkCandidate>
  ): StableForkCandidateResolution;
  isLatestRetryAssistantRow(
    ...args: Parameters<typeof implementation1.isLatestRetryAssistantRow>
  ): boolean;
  isLatestEditableUserRow(
    ...args: Parameters<typeof implementation1.isLatestEditableUserRow>
  ): boolean;
  getTurnIdForRow(...args: Parameters<typeof implementation1.getTurnIdForRow>): string | null;
  getTurnRewindAnchor(
    ...args: Parameters<typeof implementation1.getTurnRewindAnchor>
  ): string | null;
  applyEvent(...args: Parameters<typeof implementation2.applyEvent>): ConversationDelta[];
  beginHydrationReplay(...args: Parameters<typeof implementation2.beginHydrationReplay>): void;
  applyHydrationEvent(
    ...args: Parameters<typeof implementation2.applyHydrationEvent>
  ): ConversationDelta[];
  completeHydrationReplay(
    ...args: Parameters<typeof implementation2.completeHydrationReplay>
  ): ConversationDelta[];
  establishedStreamingAppend(
    ...args: Parameters<typeof implementation7.establishedStreamingAppend>
  ): string | null;
}
