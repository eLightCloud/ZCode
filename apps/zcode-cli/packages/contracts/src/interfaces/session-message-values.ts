// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export interface AssistantErrorInfo {
  name: string;
  data?: Record<string, unknown>;
}

export interface TokenUsageInfo {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}
