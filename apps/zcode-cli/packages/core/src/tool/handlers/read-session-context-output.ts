import {
  type ReadSessionContextInput,
  type ReadSessionContextOutput,
  type SessionInfo,
  type TraceContext,
} from "@zcode/contracts";

import {
  liteInputCharBudget,
  type SessionContextMaterial,
  type TranscriptChunk,
} from "../../session-context/read-session-context.js";

import type { ToolExecutionContext } from "../types.js";

export const MAX_READ_SESSION_CONTEXT_MODEL_BYTES = 80_000;

// 关联对话读取会扫描持久化历史，并可能等待 lite 模型抽取大对话上下文；固定 5 分钟避免大历史误超时。
export const DEFAULT_TIMEOUT_MS = 300_000;

export const NO_RELEVANT_CONTEXT = "NO_RELEVANT_CONTEXT";

export function extractionInstructions(strategy: ReadSessionContextInput["strategy"]): string {
  if (strategy === "handoff") {
    return [
      "Extract a handoff capsule from this material.",
      "Include current objective, decisions already made, files/commands/tests mentioned, blockers, and concrete next steps.",
      "Keep unrelated chat out.",
    ].join("\n");
  }

  return [
    "Extract only context relevant to the query.",
    "Prefer concrete facts: files, commands, decisions, errors, constraints, user preferences, and unresolved next steps.",
    "Mention message ids when helpful.",
  ].join("\n");
}

export function synthesisInstructions(strategy: ReadSessionContextInput["strategy"]): string {
  if (strategy === "handoff") {
    return [
      "Synthesize these extracted notes into one bounded handoff capsule.",
      "Deduplicate repeated facts and keep the result directly actionable.",
    ].join("\n");
  }

  return [
    "Synthesize these extracted notes into one bounded context answer for the query.",
    "Deduplicate repeated facts and omit weakly related material.",
  ].join("\n");
}

export function formatChunkForLite(chunk: TranscriptChunk): string {
  return [
    `# Transcript chunk ${chunk.index + 1}`,
    `Messages: ${chunk.startMessageIndex + 1}-${chunk.endMessageIndex + 1}`,
    `Readable messages in chunk: ${chunk.messageCount}`,
    "",
    chunk.content,
  ].join("\n");
}

export function buildOutput(input: {
  content: string;
  error?: string;
  material: SessionContextMaterial;
  parsed: ReadSessionContextInput;
  session: SessionInfo;
  source: ReadSessionContextOutput["source"];
  truncated: boolean;
}): ReadSessionContextOutput {
  return {
    status: "success",
    sessionId: input.session.id,
    title: input.session.title,
    directory: input.session.directory,
    path: input.session.path,
    strategy: input.parsed.strategy,
    query: input.parsed.query,
    source: input.source,
    content: input.content,
    messageCount: input.material.messageCount,
    selectedMessageCount: input.material.selectedMessageCount,
    truncated: input.truncated,
    error: input.error,
    references: input.material.references,
  };
}

export function truncateForLite(material: string): string {
  if (material.length <= liteInputCharBudget()) return material;
  return `${material.slice(0, liteInputCharBudget() - 18)}\n...[truncated]`;
}

export function isNoRelevantContext(text: string): boolean {
  return text.trim().toUpperCase() === NO_RELEVANT_CONTEXT;
}

export function traceFromContext(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as TraceContext;
}

export function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
