import { type ActorSubmitProfile, type AskSpec } from "@zcode/dynamic-workflow";
import type { CompiledHole } from "./dynamic-workflow-hole-contract.js";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
/** 一次编译的全部产物。四个消费者共用同一个 ts.Program（编译一次，见 run service 不变式 2）。 */
export interface CompiledDynamicWorkflowScript {
  lowered: string;
  scriptHash: string;
  askSpecs: Map<string, AskSpec>;
  /** 每个 actor 站点的 submit profile。 */
  actorSubmitProfiles: ReadonlyMap<string, ActorSubmitProfile>;
  /** 站点 → 词法出生阶段名（docs/execution-engine.md「Identity: sites, ordinals, phases」）。 */
  sitePhases: ReadonlyMap<string, string>;
  /**
   * 已补全留白的函数体文本（站点 id → `(async () => { … })`；docs/execution-engine.md「The text
   * that runs」）。补全服务把 `holeBodies[siteId]` 交给引擎作为那处留白的 `code`。
   */
  holeBodies: Readonly<Record<string, string>>;
  /** 脚本里每处留白的编译期事实（开放与已补全都在，源码序）：快照与进度载荷的 type / line 来源。 */
  holes: readonly CompiledHole[];
  /**
   * 按控制流投影取的阶段表与其中开放留白的下标（`collectPhaseNames`）。补全服务用它给引擎
   * `fillHole` 的 `phaseNames` / `holes`；launch 的声明表仍来自提交方（工具层从同一份投影算）。
   */
  phases: { phaseNames: string[]; holes: number[] };
}
