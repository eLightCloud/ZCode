// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export interface ProjectMemoryUpdate {
  inContextPaths: string[];
  paths: string[];
  source: "dream";
  summary: string;
}
