import { type MemoryExtractionScheduler, type MemoryExtractionSnapshot } from "../../memory/extraction.js";
import { type ProjectMemoryAgentContext } from "./project-memory-agent-types.js";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export interface ProjectMemoryExtractionSnapshot
  extends MemoryExtractionSnapshot, ProjectMemoryAgentContext {}

export type ProjectMemoryExtractionScheduler =
  MemoryExtractionScheduler<ProjectMemoryExtractionSnapshot>;
