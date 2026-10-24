import type { ModelUsage } from "@zcode/contracts";

// 适配器内部的唯一数据形状，调用方不从实现反向取型。
export interface StreamDiagnostics {
  chunkCounts: Record<string, number>;
  errorChunkCount: number;
  finishReason?: string;
  lastChunkType?: string;
  lastErrorChunk?: unknown;
  lastFinishChunk?: unknown;
  rawFinishReason?: unknown;
  reasoningDeltaChars: number;
  hasReasoningContent: boolean;
  textDeltaChars: number;
  toolCallCount: number;
  usage?: ModelUsage;
}
