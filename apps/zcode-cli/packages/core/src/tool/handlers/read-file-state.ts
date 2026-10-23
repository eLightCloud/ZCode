// ============================================================
// Read Tool Handler
// ============================================================

import type { ReadFileStateEntry, ReadFileStateMap, ToolExecutionContext } from "../types.js";

import { type FileSystemStatResult, type ReadOutput, type ReadTextOutput } from "@zcode/contracts";

import { normalizeReadFileStateMtimeMs } from "../read-file-state.js";

import { createReadFileStateMetadata } from "../read-file-state-metadata.js";

export const fallbackReadFileStates = new WeakMap<ToolExecutionContext, ReadFileStateMap>();

export function getReadFileState(context: ToolExecutionContext): ReadFileStateMap {
  if (context.readFileState) return context.readFileState;
  const existing = fallbackReadFileStates.get(context);
  if (existing) return existing;
  const state: ReadFileStateMap = new Map();
  fallbackReadFileStates.set(context, state);
  return state;
}

export function normalizeCacheOffset(offset: number | undefined): number {
  return offset === undefined ? 1 : offset;
}

export function isCachedReadFresh(entry: ReadFileStateEntry, stat: FileSystemStatResult): boolean {
  if (entry.isPartialView) return false;

  const mtimeMs = stat.revision?.mtimeMs ?? stat.mtimeMs;
  if (entry.mtimeMs !== undefined && mtimeMs !== undefined) {
    // 和写前 freshness 校验保持同一套策略，mtime 只比较整数毫秒。
    return (
      normalizeReadFileStateMtimeMs(entry.mtimeMs) === normalizeReadFileStateMtimeMs(mtimeMs) &&
      entry.sizeBytes === stat.sizeBytes
    );
  }

  const revisionId = stat.revision?.id;
  if (entry.revisionId && revisionId) return entry.revisionId === revisionId;

  return entry.sizeBytes !== undefined && entry.sizeBytes === stat.sizeBytes;
}

export function updateReadFileState(
  state: ReadFileStateMap,
  key: string,
  input: {
    output: ReadTextOutput;
    path: string;
    stat: FileSystemStatResult;
    rangeReadRevision?: FileSystemStatResult["revision"];
    offset?: number;
    limit?: number;
  },
): void {
  const revision = input.stat.revision ?? input.rangeReadRevision;
  state.set(key, {
    path: input.path,
    content: input.output.content,
    offset: input.offset,
    limit: input.limit,
    // offset/limit 是 range view，不等价于 partial view。
    // partial view 只表示模型看到的内容被工具截断，Write/Edit 必须拒绝这种不完整视图。
    isPartialView: input.output.truncatedByTokenCap === true,
    readAt: new Date(),
    sourceTool: "Read",
    revisionId: revision?.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision?.mtimeMs ?? input.stat.mtimeMs),
    sizeBytes: input.stat.sizeBytes,
  });
}

export function recordReadFileStateMetadata(
  context: ToolExecutionContext,
  input: {
    output: ReadOutput;
    readFileState: ReadFileStateMap;
    toolInput: unknown;
  },
): void {
  if (!context.recordReadFileStateMetadata) return;
  const metadata = createReadFileStateMetadata({
    completedAt: new Date(),
    output: input.output,
    readFileState: input.readFileState,
    toolInput: input.toolInput,
    toolName: "Read",
  });
  if (metadata) context.recordReadFileStateMetadata(metadata);
}
