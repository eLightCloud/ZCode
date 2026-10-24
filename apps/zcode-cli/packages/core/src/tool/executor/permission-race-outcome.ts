import type { PermissionBrokerResult } from "@zcode/contracts";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export interface PermissionResponderRaceOutcome {
  result: PermissionBrokerResult;
  source: "hook" | "broker";
}
