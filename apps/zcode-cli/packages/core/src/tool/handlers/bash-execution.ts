// ============================================================
// Bash Tool Handler
// ============================================================

import {
  BashInputSchema,
  CoreErrorType,
  createCoreError,
  type BackgroundExecutionStartResult,
  type BashInput,
  type BashOutput,
  type CommandExecutionSpanWriter,
  type ExecutionRequest,
  type ExecutionRunOptions,
  type TraceContext,
} from "@zcode/contracts";

import {
  shouldInjectEmbeddedSearchBashPrelude,
  supportsEmbeddedSearchShellSelection,
} from "../../embedded-search/shell.js";

import type { ToolEntry, ToolExecutionContext } from "../types.js";

import { resolveToolWorkingDirectory } from "../path-policy.js";

import { decideBashCwdPolicy } from "./bash-cwd-policy.js";

import {
  createBashBackgroundPerformanceTelemetry,
  createEmptyBashPerformanceTelemetry,
  toBashOutput,
  type BashProgressTiming,
} from "./bash-output.js";

import { attachToolExecutionTelemetry } from "./tool-perf.js";

import { applyBashReadFileStateEffects } from "./bash-read-file-state.js";

import { isBashAutoBackgroundEligible } from "./bash-background-policy.js";

import { supportsBashBackgroundLifecycle } from "./bash-background-lifecycle.js";

import { resolveBashTimeoutMs, type BashTimeoutPolicy } from "../bash-timeout-policy.js";

import {
  emitProgressEvent,
  finishBashCommandTelemetry,
  startBashCommandTelemetry,
} from "./bash-execution-telemetry.js";

export {
  commandCategory,
  commandShellKind,
  emitProgressEvent,
  finishBashCommandTelemetry,
  startBashCommandTelemetry,
} from "./bash-execution-telemetry.js";

export const MAX_INLINE_OUTPUT_BYTES = 30_000;

export const MAX_RUNTIME_PERSISTED_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;

export async function executeBashHandler(
  input: unknown,
  context: ToolExecutionContext,
  timeoutPolicy: BashTimeoutPolicy,
): Promise<BashOutput> {
  const parsed = BashInputSchema.parse(input) as BashInput;
  const executionPort = context.executionPort;

  if (!executionPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ExecutionPort is not configured for Bash tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Bash",
        },
        recoverable: false,
      },
    );
  }

  if (parsed.command.trim().length === 0) {
    const commandTelemetry = startBashCommandTelemetry(parsed, context);
    commandTelemetry?.finishCompleted();
    return emptyBashOutput(parsed);
  }

  const request = createExecutionRequest(parsed, context, timeoutPolicy);
  const progressTiming: BashProgressTiming = {};
  const commandTelemetry = startBashCommandTelemetry(parsed, context);
  const runOptions = createExecutionRunOptions(context, progressTiming, commandTelemetry);
  // 闲时后台归属由 Runtime 生命周期保留，Bash 复用普通显式/超时后台路径。
  const eligibleForAutoBackground = isBashAutoBackgroundEligible(parsed);
  const backgroundLifecyclePort = supportsBashBackgroundLifecycle(executionPort)
    ? executionPort
    : undefined;

  if (parsed.run_in_background && !backgroundLifecyclePort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ExecutionPort does not support the Bash background lifecycle",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Bash",
        },
        recoverable: false,
      },
    );
  }

  const runCommand = async () =>
    parsed.run_in_background && backgroundLifecyclePort
      ? backgroundLifecyclePort.runBashWithBackgroundLifecycle(
          request,
          { mode: "explicit" },
          runOptions,
        )
      : eligibleForAutoBackground && backgroundLifecyclePort
        ? backgroundLifecyclePort.runBashWithBackgroundLifecycle(
            request,
            { mode: "auto_on_timeout" },
            runOptions,
          )
        : {
            kind: "foreground" as const,
            result: await executionPort.run(request, runOptions),
          };
  const runResult = commandTelemetry
    ? await commandTelemetry.run(async () => {
        const observed = await runCommand();
        if (observed.kind === "backgrounded") {
          commandTelemetry.finishBackgrounded();
        } else {
          finishBashCommandTelemetry(commandTelemetry, observed.result);
        }
        return observed;
      })
    : await runCommand();

  if (runResult.kind === "backgrounded") {
    return toBackgroundedBashOutput(runResult.task, parsed);
  }

  const result = runResult.result;
  const cwdDecision = decideBashCwdPolicy({
    status: result.status,
    exitCode: result.exitCode,
    resolvedCwd: result.resolvedCwd,
    workspaceRoot: context.workspaceRoot,
    runtimeScope: context.runtimeScope,
  });
  if (cwdDecision.nextWorkingDirectory) {
    // 主线程 Bash 成功后会保留项目内 cwd；
    // 离开项目边界时 reset 回原始工作区，并把 reset 文案放进 Bash stderr。
    await context.setWorkingDirectory?.(cwdDecision.nextWorkingDirectory);
  }
  const output = await toBashOutput(result, parsed, context, {
    progressTiming,
    stderrSuffix: cwdDecision.stderrSuffix,
  });
  await applyBashReadFileStateEffects({
    command: parsed.command,
    context,
    output,
    result,
  });
  return output;
}

export function emptyBashOutput(input: BashInput): BashOutput {
  return attachToolExecutionTelemetry(
    {
      stdout: "",
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      status: "completed",
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    createEmptyBashPerformanceTelemetry(input),
  );
}

export function toBackgroundedBashOutput(
  task: BackgroundExecutionStartResult,
  input: BashInput,
): BashOutput {
  return attachToolExecutionTelemetry(
    {
      stdout: "",
      stderr: "",
      interrupted: false,
      status: "backgrounded",
      backgroundTaskId: task.taskId,
      rawOutputPath: task.outputPath,
      persistedOutputPath: task.outputPath,
      stdoutPersistedOutputPath: task.stdoutPersistedOutputPath,
      stderrPersistedOutputPath: task.stderrPersistedOutputPath,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    createBashBackgroundPerformanceTelemetry(input),
  );
}

export function createExecutionRunOptions(
  context: ToolExecutionContext,
  progressTiming?: BashProgressTiming,
  telemetry?: CommandExecutionSpanWriter,
): ExecutionRunOptions {
  return {
    signal: context.abortSignal,
    onEvent: async (event) => {
      if (event.type !== "progress") return;
      if (
        progressTiming &&
        progressTiming.firstOutputMs === undefined &&
        event.stdoutBytes + event.stderrBytes > 0
      ) {
        progressTiming.firstOutputMs = Math.max(0, Math.round(event.elapsedMs));
        telemetry?.markFirstOutput();
      }
      await emitProgressEvent(event, context);
    },
  };
}

export function createExecutionRequest(
  input: BashInput,
  context: ToolExecutionContext,
  timeoutPolicy: BashTimeoutPolicy,
): ExecutionRequest {
  const shellSelection = context.bashShellSelection;
  const bashPrelude =
    shouldInjectEmbeddedSearchBashPrelude() &&
    context.embeddedSearch?.enabled === true &&
    context.embeddedSearch.backend &&
    supportsEmbeddedSearchShellSelection(shellSelection)
      ? {
          kind: "embedded-search" as const,
          backend: context.embeddedSearch.backend,
          ...(context.embeddedSearch.findAndGrepEnabled === false
            ? { findAndGrepEnabled: false }
            : {}),
        }
      : undefined;
  return {
    command: {
      mode: "shell",
      command: input.command,
      shellProfile: "posix-bash",
      ...(shellSelection ? { shellOverride: shellSelection } : {}),
    },
    cwd: resolveToolWorkingDirectory(undefined, {
      operation: "execute",
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    }),
    ...(bashPrelude ? { bashPrelude } : {}),
    captureCwdAfterSuccess: input.run_in_background ? undefined : true,
    timeoutMs: resolveBashTimeoutMs(input.timeout, timeoutPolicy),
    outputLimit: {
      maxInlineBytes: MAX_INLINE_OUTPUT_BYTES,
      maxBufferBytes: MAX_INLINE_OUTPUT_BYTES,
      maxPersistedBytes: MAX_RUNTIME_PERSISTED_OUTPUT_BYTES,
      persistOutput: input.run_in_background ? "always" : "on_truncate",
    },
    sandbox: {
      enabled: !input.dangerouslyDisableSandbox,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    trace: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      attributes: {
        toolCallId: context.toolCallId,
        toolName: "Bash",
      },
    } as unknown as TraceContext,
  };
}

export function createBashTimeoutBudgetResolver(
  timeoutPolicy: BashTimeoutPolicy,
): NonNullable<ToolEntry["resolveTimeoutBudgetMs"]> {
  return (input) => {
    const parsed = BashInputSchema.safeParse(input);
    // 旧 watchdog 直接读取 raw timeout，导致 0 被压成 1ms，且字符串数字绕过
    // Bash policy。这里和 handler 共用 timeout || default / max 解析后再加 cleanup grace。
    return resolveBashTimeoutMs(parsed.success ? parsed.data.timeout : undefined, timeoutPolicy);
  };
}
