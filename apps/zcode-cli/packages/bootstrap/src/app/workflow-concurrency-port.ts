import { type ModelRequestAdmissionTicket } from "@zcode/contracts";
import { type ConcurrencyChange } from "@zcode/dynamic-workflow";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
/**
 * driver 看到的窄端口（不是整个治理器）。
 *
 * - `tryAdmit`：同步快路径——闸门开着**且没有任何人在排队**才给 ticket；否则 undefined，调用方再走
 *   `admit` 并报「等待槽位」。有等待者时不走快路径是公平性：否则一个请求密集的 run 会靠
 *   快路径越过别的 run 的队列。
 * - `admit`：排队（run 间轮转）直到 `inFlight < cap` 且不在 Retry-After 冷却；`signal` 被 abort 即
 *   出队并 reject（reject 原因是 `signal.reason`）。
 * - `subscribe`：本 run 触到的任何 key 上的 cap 变化。扇出只到**此刻在该 key 上有在飞或排队请求**的
 *   run（决策 8）。
 * - `setRunBound` / `clearRunBound`：本 run 自己的并发上界（launch 时登记、每次 retune 覆盖、launch
 *   结算时清掉）。它抬的是这个 run **用过的** key 的增长上限：`max(2D, 这些 run 的最大上界)`
 *   （docs/dynamic-workflow/concurrency.md「The governor」）——用户把一个 run 调到 40，桶的 cap 才
 *   爬得到 40，否则 40 个子代理会有一大半停在「等待槽位」。
 */
export interface WorkflowConcurrencyPort {
  tryAdmit(runId: string, key: string): ModelRequestAdmissionTicket | undefined;
  admit(runId: string, key: string, signal: AbortSignal): Promise<ModelRequestAdmissionTicket>;
  subscribe(runId: string, listener: (change: ConcurrencyChange) => void): () => void;
  setRunBound(runId: string, bound: number): void;
  clearRunBound(runId: string): void;
}
