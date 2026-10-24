// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
/** 激活的来源，落进 session entry 供排查；行为上四者等价。 */
export type DynamicWorkflowActivationSource =
  | "command"
  | "run_control"
  | "resume_entry"
  | "resume_history";

export interface DynamicWorkflowActivationEntryData {
  activated: true;
  source: DynamicWorkflowActivationSource;
}
