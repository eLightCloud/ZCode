// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export interface ColdEventMergeDiagnostic {
  code:
    | "cold_merge.durable_event_suppressed"
    | "cold_merge.ambiguous_legacy_turn_preserved"
    | "cold_merge.settled_queue_event_suppressed"
    | "cold_merge.memory_boundary_preserved"
    | "cold_merge.non_product_event_suppressed"
    | "cold_merge.unclassified_event_preserved";
  count: number;
  eventTypes: Record<string, number>;
}
