import { type ProjectMemoryExtractionSnapshot } from "./project-memory-extraction-types.js";
export type { ProjectMemoryExtractionScheduler } from "./project-memory-extraction-types.js";
import {
  selectActiveConversationBranch,
  traceContextToLogContext,
  type TraceContext,
} from "../deps.js";
import {
  buildMemoryExtractionPrompt,
  createMemoryExtractionScheduler,
} from "../../memory/extraction.js";
import { runMemoryAgentLoop } from "../../memory/memory-agent-loop.js";
import { scanMemoryManifest } from "../../memory/recall/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  prepareProjectMemoryAgentRequest,
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolExecutor,
} from "./project-memory-agent.js";
import { type ProjectMemoryAgentContext } from "./project-memory-agent-types.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";

const EXTRACTION_MAX_TURNS = 5;
const EXTRACTION_DRAIN_TIMEOUT_MS = 60_000;
const EXTRACTION_EXECUTION_TIMEOUT_MS = 5 * 60_000;

export function isProjectMemoryEnabled(this: AgentRuntimeInternal): boolean {
  return resolveEnabledProjectMemoryRoot(this.config, this.workspaceRoot) !== undefined;
}

export function scheduleProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: { model: ProjectMemoryAgentContext["model"]; traceContext: TraceContext },
): void {
  if (runtime.shuttingDown) return;
  // 原因：headless 只关闭自动 Extraction，必须在读取快照或访问文件前返回，避免后台副作用。
  if (runtime.config.memory?.extractionEnabled === false) return;
  // Bash cd 只改变执行 cwd，project Memory 身份必须继续使用会话 workspace root。
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot) return;
  if (runtime.isRemoteWorkspace()) return;
  if (!runtime.sessionStore || !runtime.fileSystemPort) return;

  const snapshotBase = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    model: input.model,
    operation: "project_memory_extract",
    traceContext: input.traceContext,
  });
  const snapshotBoundaryMessageId = runtime.latestConversationMessageId;
  if (!snapshotBoundaryMessageId) return;
  const durableMessages = runtime.sessionStore.messages({ sessionID: runtime.sessionId });
  const session = runtime.sessionStore.getSession(runtime.sessionId);
  const snapshot = Promise.all([durableMessages, session]).then(
    ([messages, scheduledSession]): ProjectMemoryExtractionSnapshot => {
      const activeMessages = selectActiveConversationBranch(messages, {
        branchCutAfterMessageId: scheduledSession?.revert?.branchCutAfterMessageID,
        rewindCreatedMessageId: scheduledSession?.revert?.createdMessageID,
        rewindKeptMessageIds: scheduledSession?.revert?.keptMessageIDs,
        rewindTargetMessageId: scheduledSession?.revert?.targetMessageID,
      });
      const boundaryIndex = activeMessages.findIndex(
        (message) => message.info.id === snapshotBoundaryMessageId,
      );
      if (boundaryIndex < 0) {
        throw new Error("Extraction boundary is missing from the scheduled active branch");
      }
      return {
        ...snapshotBase,
        boundaryMessageId: snapshotBoundaryMessageId,
        durableMessages: activeMessages.slice(0, boundaryIndex + 1),
      };
    },
  );

  runtime.memoryExtractionScheduler ??= createMemoryExtractionScheduler((extraction) =>
    executeProjectMemoryExtraction(runtime, extraction),
  );
  runtime.memoryExtractionScheduler.schedule(snapshot);
}

export async function drainMemoryExtractions(
  this: AgentRuntimeInternal,
  timeoutMs: number | null = EXTRACTION_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const scheduler = this.memoryExtractionScheduler;
  if (!scheduler) return;
  // benchmark 显式等待自然结束；普通 session close 仍保留原有有界取消清理。
  if (timeoutMs === null) {
    await scheduler.drain();
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scheduler.drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function executeProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    messageCount: number;
    snapshot: ProjectMemoryExtractionSnapshot;
  },
) {
  const telemetry = runtime.agentTelemetry.detached({
    causation: input.snapshot.causation,
    executionKind: "background",
    operation: "project_memory_extract",
    targetKind: "project_memory",
    traceContext: input.snapshot.traceContext,
    trigger: "scheduler",
  });

  return telemetry.run(async () => {
    // 非流式模型请求可能永不 settle；轮数限制不能收口这类等待，导致 idle 会话永久拒绝配置刷新。
    // 期限只取消本次 Extraction，仍等 adapter 的取消收口，不能直接清空 scheduler/residency 事实。
    const deadline = new AbortController();
    const abortSignal = AbortSignal.any([input.abortSignal, deadline.signal]);
    const timer = setTimeout(() => {
      deadline.abort(new DOMException("Memory extraction deadline exceeded", "TimeoutError"));
    }, EXTRACTION_EXECUTION_TIMEOUT_MS);
    timer.unref?.();
    const diagnostic = {
      ...traceContextToLogContext(input.snapshot.traceContext),
      event: "memory.extraction",
      module: "core.runtime",
    };
    runtime.logger?.info("Memory extraction started", { ...diagnostic, outcome: "started" });
    try {
      const manifest = await scanMemoryManifest({
        fileSystem: runtime.fileSystemPort!,
        rootDir: input.snapshot.memoryRoot,
        signal: abortSignal,
      });
      abortSignal.throwIfAborted();
      const prompt = buildMemoryExtractionPrompt({
        manifest,
        messageCount: input.messageCount,
      });
      const request = prepareProjectMemoryAgentRequest(input.snapshot, prompt);
      const executor = createProjectMemoryAgentToolExecutor(runtime, input.snapshot);

      await runMemoryAgentLoop({
        abortSignal,
        executeTool: (toolCall, options) =>
          executor.execute(toolCall, {
            signal: options.abortSignal,
            traceContext: input.snapshot.traceContext,
          }),
        maxTurns: EXTRACTION_MAX_TURNS,
        request,
        model: input.snapshot.model,
        rootDir: input.snapshot.memoryRoot,
        workingDirectory: input.snapshot.workingDirectory,
        workspaceRoot: input.snapshot.workspaceRoot,
      });
      abortSignal.throwIfAborted();
      telemetry.finishCompleted();
      runtime.logger?.info("Memory extraction completed", { ...diagnostic, outcome: "completed" });
      return "success" as const;
    } catch (error) {
      if (input.abortSignal.aborted || (!deadline.signal.aborted && isAbortError(error))) {
        telemetry.finishCancelled("abort_signal");
        runtime.logger?.info("Memory extraction cancelled", {
          ...diagnostic,
          outcome: "cancelled",
          reason: "abort_signal",
        });
        return "aborted" as const;
      }
      telemetry.finishFailed("execute", "internal", error);
      runtime.logger?.warn("Memory extraction failed", {
        ...diagnostic,
        outcome: "failed",
        reason: deadline.signal.aborted ? "deadline_exceeded" : "execution_failed",
      });
      return "error" as const;
    } finally {
      clearTimeout(timer);
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
