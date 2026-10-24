import { type MemoryManifestEntry, type RecalledMemory } from "../../memory/recall/index.js";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export interface PrefetchedMemory {
  entry: MemoryManifestEntry;
  memory: RecalledMemory;
}

export interface ProjectMemoryRecallPrefetch {
  abortController: AbortController;
  consumed: boolean;
  detachTurnAbort: () => void;
  memories: PrefetchedMemory[];
  settled: boolean;
}
