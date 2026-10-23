import type { TraceContext, TurnSteerResult } from "@zcode/contracts";

import type { SteerTurnOptions } from "./types.js";
export interface AppInputApi {
  /**
   * v4 deferred queue：busy 但没有 steerable active turn（compact / goal verifier /
   * goal continuation 边界）时，普通输入必须先落 TurnSteerQueued，不能因
   * runtime.steerTurn(no_active_turn/turn_not_steerable) 从 composer 消失。
   */
  enqueueDeferredInput?(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;

  steerTurn(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;

  /** v4 queue 单项删除：按 pendingInputId 移除一条排队输入。返回是否命中。 */
  removeQueueItem(
    pendingInputId: string,
    options?: {
      reason?: "user_removed" | "promoted";
      reservationId?: string;
      traceContext?: TraceContext;
    },
  ): Promise<boolean>;

  /** sendQueuedNow 原子提升：reserve 后普通 drain/delete 不得消费该项。 */
  reserveQueueItem(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;

  markQueueItemPromoting(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;

  releaseQueueItemReservation(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;

  /** v4 queue 单项编辑：按 pendingInputId 替换排队输入文本（保位）。返回是否命中。 */
  editQueueItem(
    pendingInputId: string,
    newText: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;

  /** v4 queue 重排：移动 pendingInputId 到 beforePendingInputId 之前（null=队尾）。 */
  reorderQueueItem(
    pendingInputId: string,
    beforePendingInputId: string | null,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;

  /** v4 heldQueueDisposition=clearQueueAndSend：清空全部排队输入，返回丢弃条数。 */
  clearQueueItems(options?: { traceContext?: TraceContext }): Promise<number>;

  /** v4 setAutoDrain：翻转 queue autoDrain 授权位（会话级配置）。 */
  setQueueAutoDrain(autoDrain: boolean, options?: { traceContext?: TraceContext }): Promise<void>;

  /** 暂停队列已由 CLI 外层消费到空：恢复 core 对后续 running queue 的行内 drain。 */
  completeExternalQueueDrain(): void;

  /** v4 setFollowupMode：翻转 followup 路由模式（queue/guide，会话级配置）。 */
  setFollowupMode(
    mode: "queue" | "guide",
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
}
