import { type ModelRequestAdmission, type SessionId } from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type { AskLastTool, AskProgress } from "@zcode/dynamic-workflow";
import { type ActorToolCounts } from "./workflow-driver-tool-activity.js";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
/**
 * 一个 actor 的**观察面**：它 runtime 的 `ModelRequestAdmission`（准入）、它会话事件流里的模型状态
 * （executing / waiting 徽标的来源），以及同一条流里的工具调用（第一笔工作区写入 → 关导入缓存，
 * 加上这个 ask 的工具计数，见 workflow-driver-tool-activity.ts）。三者共用 per-ask 生命周期，所以
 * driver 只持有一个对象、只 observe / reset / unsubscribe 一次；「等槽位」之后的那次
 * `model_request_started` 也因此能被认出是恢复。
 */
export interface ActorModelActivity {
  /** 交给 runtime deps 的准入端口；治理器端口缺席时为 undefined（不受闸门约束）。 */
  readonly admission: ModelRequestAdmission | undefined;
  /** 换 ask 时归零：上一个 ask 的 waiting / executing 相位与工具计数都不能带到下一个 ask。 */
  reset(): void;
  /** 本 ask 至今观察到的工具调用计数（喂给 AskStats）。 */
  toolCounts(): ActorToolCounts;
  /** 本 ask 至今最近一次开跑的工具调用（喂给 `node-progress` 的 lastTool）。 */
  lastTool(): AskLastTool | undefined;
  /**
   * 记下「又一轮 turn 解析完了」，并给出这一刻的 ask 进度（`turn` 从 1 起）。
   * 计数住在这里而不是 SessionState 上，因为它与工具计数是同一条 per-ask 生命周期：
   * 同一个 reset 归零，同一个 ask 内累加，nudge 起的新一轮算第二个 turn。
   */
  noteTurnResolved(): AskProgress;
  /** 订阅 runtime 的会话事件（模型状态 + 工具调用）；最小 stub runtime 没有 subscribeEvents 时空操作。 */
  observe(runtime: AgentRuntime, sessionId: SessionId): void;
  unsubscribe(): void;
}

/** 时钟与定时器（可注入，测试用假时间）。 */
export interface WorkflowClock {
  now?: () => number;
  /** 返回取消函数。 */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/**
 * 一个 run 的停滞观察：所有 actor（turn 与工具侧请求一体）共用一只表。
 *   - `noteSuccess`：任一 `model_request_completed` → 归零、撤闹钟、清 reason 计数，本段结束；
 *   - `noteRetryScheduled`：一次 `model_retry_scheduled` → 计 reason；本段还没上膛就定闹钟到
 *     「上次成功 + afterMs」；
 *   - 闹钟响：距上次成功 ≥ afterMs 且本段至少排定过一次重试 → `onStalled` 恰好一次（每个 stall
 *     段一条），直到下一次成功才重新上膛；
 *   - `noteCap`：治理器扇出的 cap 变化——通知里顺带报此刻的 cap（最近一次扇出的值；没见过就缺席）。
 * 纯观察，不做任何决策；run 结算后 `dispose` 撤闹钟。
 */
export interface RunStallClock {
  noteSuccess(): void;
  noteRetryScheduled(reason: string): void;
  noteCap(cap: number): void;
  dispose(): void;
}
