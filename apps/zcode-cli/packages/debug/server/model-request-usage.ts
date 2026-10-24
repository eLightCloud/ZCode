import { isRecord, numberValue } from "./observation-record-values.js";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export function extractUsage(payload?: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const usage = isRecord(payload?.usage) ? payload.usage : payload;
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  return {
    inputTokens: numberValue(usage.inputTokens) ?? numberValue(usage.input) ?? 0,
    outputTokens: numberValue(usage.outputTokens) ?? numberValue(usage.output) ?? 0,
    totalTokens: numberValue(usage.totalTokens) ?? numberValue(usage.total) ?? 0,
    cacheReadTokens:
      numberValue(usage.cacheReadTokens) ??
      numberValue(isRecord(usage.cache) ? usage.cache.read : undefined) ??
      0,
    cacheWriteTokens:
      numberValue(usage.cacheWriteTokens) ??
      numberValue(isRecord(usage.cache) ? usage.cache.write : undefined) ??
      0,
  };
}
