// goal/compact 命令组：compact / sendGoalCommand / pauseGoal / resumeGoal。
// 语义自旧 server-operations compactSession/goalSession/continueGoalAfterChange 搬运，
// 决策逻辑（compact 去重 / active turn barrier / goal 续跑）直驱 core，不经旧协议 op。
//
// 与旧协议路径的映射（保真基线）：
// - compactSession（server-operations.ts:1805）→ compact
// - goalSession action:"set"（:1919，含重复 set 收敛 replace）→ sendGoalCommand
// - goalSession action:"resume"（:1980）→ resumeGoal
// - continueGoalAfterChange / runGoalContinuationInBackground（:2204-2269）→ 组内私有共用函数

/** goal/compact 组的裁决拒绝（gateway 捕获后进 ACK failed，message 透传给客户端）。 */
export class V4GoalCompactRejectedError extends Error {
  constructor(
    readonly reasonCode:
      | "activeTurn"
      | "compactOperationLock"
      | "restoreWarning"
      | "guard.planGoalMutuallyExclusive"
      | "emptyObjective",
    message: string,
  ) {
    super(message);
    this.name = "V4GoalCompactRejectedError";
  }
}
