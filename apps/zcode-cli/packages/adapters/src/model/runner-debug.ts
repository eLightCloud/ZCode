import type { ModelTextResult } from "@zcode/contracts";

import { ZCODE_RUNTIME_ENV_KEY, normalizeZCodeRuntimeEnv } from "@zcode/shared";

import { redactAnthropicRequestMetadata } from "./anthropic-request-metadata.js";

import type { EnvRecord } from "./model-execution.js";

import { getGenerateTextResultMetadata } from "./runner-diagnostics.js";

import {
  normalizeReasoning,
  normalizeSources,
  normalizeToolResults,
  normalizeUsage,
} from "./runner-normalization.js";

import { stringMetadata } from "./runner-record.js";

import type {
  AiSdkGenerateTextOptions,
  AiSdkGenerateTextResult,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";

import { serializeError, writeModelIODebugRecord } from "./model-io-storage.js";

import { removeUndefined } from "./model-io-compaction.js";

export function shouldRecordModelIO(env: EnvRecord): boolean {
  // 开发态与生产态都记录(分别落到 debug / rollout 目录);仅测试态(ZCODE_RUNTIME_ENV=test)不写,
  // 避免单测产生磁盘副作用。未设时按生产处理(记录到 rollout,带条数上限)。
  return normalizeRuntimeEnv(env) !== "test";
}

// 判定当前是否开发态,用于选择落盘目录(debug vs rollout)。
// 直接看 ZCODE_RUNTIME_ENV === "development";dev 桌面/CLI 启动时已注入该变量。
export function isDevelopmentModelIOEnv(env: EnvRecord): boolean {
  return normalizeRuntimeEnv(env) === "development";
}

export function recordGenerateTextDebug(input: {
  attempt: number;
  debugDir?: string;
  error?: unknown;
  isDev: boolean;
  modelIoFullRetentionEnabled: boolean;
  normalizedToolCalls: ModelTextResult["toolCalls"];
  options: AiSdkGenerateTextOptions;
  recordModelIO: boolean;
  request: AiSdkModelTextRequest;
  requestId: string;
  resolved: ResolvedAiSdkModel;
  result?: AiSdkGenerateTextResult;
  startedAt: number;
}): void {
  if (!input.recordModelIO) {
    return;
  }

  const completedAt = Date.now();
  const resultWithMetadata = getGenerateTextResultMetadata(input.result);
  const metadata = input.request.metadata ?? {};
  const requestBody =
    input.resolved.rawRequestBodyCapture?.body ??
    resultWithMetadata?.request?.body ??
    (input.error
      ? buildFallbackRequestBodyFromOptions({
          options: input.options,
          resolved: input.resolved,
          stream: false,
        })
      : undefined);

  writeModelIODebugRecord(
    {
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - input.startedAt,
      error: input.error ? serializeError(input.error) : undefined,
      requestId: input.requestId,
      attempt: input.attempt,
      model: {
        modelId: input.resolved.modelId,
        providerId: input.resolved.providerId,
      },
      request: {
        body: redactAnthropicRequestMetadata(requestBody),
        headers: input.options.headers,
        maxOutputTokens: input.options.maxOutputTokens,
        messages: input.request.messages,
        providerOptions: input.request.providerOptions,
        sdkMessages: input.options.messages,
        temperature: input.request.temperature,
        toolChoice: input.request.toolChoice,
        toolNames: input.request.tools?.map((toolContract) => toolContract.name) ?? [],
      },
      response: input.result
        ? {
            body: resultWithMetadata?.response?.body,
            finishReason: input.result.finishReason,
            headers: resultWithMetadata?.response?.headers,
            modelId: resultWithMetadata?.response?.modelId,
            providerMetadata: input.result.providerMetadata,
            // 运行结果已有 reasoning，但 model-io 过去只记录 text，
            // 导致调用轨迹无法得到 response.reasoningText，始终不显示思考过程。
            reasoningText: modelIOReasoningText(input.result.reasoning),
            responseId: resultWithMetadata?.response?.id,
            text: input.result.text,
            toolCalls: input.normalizedToolCalls,
            toolResults: normalizeToolResults(input.result, input.normalizedToolCalls),
            sources: normalizeSources(input.result),
            usage: normalizeUsage(input.result.totalUsage ?? input.result.usage),
          }
        : undefined,
      sessionId: stringMetadata(metadata.sessionId),
      querySource: stringMetadata(metadata.querySource),
      startedAt: new Date(input.startedAt).toISOString(),
      traceId: stringMetadata(metadata.traceId),
      turnId: stringMetadata(metadata.turnId),
      type: "model_io",
    },
    input.debugDir,
    input.isDev,
    input.modelIoFullRetentionEnabled,
  );
}

/**
 * 流式请求的 model I/O 记录。
 *
 * 背景（bug：开发态桌面 agent 始终走流式，model-io 一直为空）：
 * 只在非流式 `runGenerateText` 里写 model-io 会让桌面/协议端默认 `modelStreaming: "on"` 的
 * 每个 turn（`streamText`）即便 ZCODE_RUNTIME_ENV=development 也从不落盘。流式路径同样要记录。
 *
 * 与 generate 路径的关键差异：StreamTextResult 的 text/toolResults/sources/response 等聚合字段是 **promise**，
 * 必须等 fullStream 读完后再 await；toolResults/sources 的归一化期望数组，
 * 所以先解析聚合 promise，再用合成对象处理。toolCalls 则直接复用 assembler 的归一化快照。
 * 任何失败都不得影响模型请求路径。
 */
export async function recordStreamTextDebug(input: {
  attempt: number;
  debugDir?: string;
  error?: unknown;
  isDev: boolean;
  modelIoFullRetentionEnabled: boolean;
  normalizedToolCalls: ModelTextResult["toolCalls"];
  options: AiSdkStreamTextOptions;
  recordModelIO: boolean;
  request: AiSdkModelTextRequest;
  requestId: string;
  resolved: ResolvedAiSdkModel;
  result?: AiSdkStreamTextResult;
  startedAt: number;
}): Promise<void> {
  if (!input.recordModelIO) {
    return;
  }

  try {
    // 成功路径下解析完整聚合结果；失败路径只读取 request/response 元数据，且必须限时——
    // 流中途被 abort（用户 Stop / idle timeout）后 AI SDK 的聚合 promise 永不 settle。
    const aggregate = input.result
      ? input.error
        ? await resolveFailedStreamModelIOAggregate(input.result, input.request.abortSignal)
        : await resolveStreamModelIOAggregate(input.result)
      : undefined;
    const completedAt = Date.now();
    const metadata = input.request.metadata ?? {};
    const requestBody =
      input.resolved.rawRequestBodyCapture?.body ??
      aggregate?.requestBody ??
      (input.error
        ? buildFallbackRequestBodyFromOptions({
            options: input.options,
            resolved: input.resolved,
            stream: true,
          })
        : undefined);
    const syntheticResult = {
      toolResults: aggregate?.toolResults,
      sources: aggregate?.sources,
    } as unknown as AiSdkGenerateTextResult;

    writeModelIODebugRecord(
      {
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - input.startedAt,
        error: input.error ? serializeError(input.error) : undefined,
        requestId: input.requestId,
        attempt: input.attempt,
        model: {
          modelId: input.resolved.modelId,
          providerId: input.resolved.providerId,
        },
        request: {
          body: redactAnthropicRequestMetadata(requestBody),
          headers: input.options.headers,
          maxOutputTokens: input.options.maxOutputTokens,
          messages: input.request.messages,
          providerOptions: input.request.providerOptions,
          sdkMessages: input.options.messages,
          temperature: input.request.temperature,
          toolChoice: input.request.toolChoice,
          toolNames: input.request.tools?.map((toolContract) => toolContract.name) ?? [],
        },
        response: aggregate
          ? {
              body: aggregate.responseBody,
              finishReason: aggregate.finishReason,
              headers: aggregate.responseHeaders,
              modelId: aggregate.responseModelId,
              providerMetadata: aggregate.providerMetadata,
              reasoningText: modelIOReasoningText(aggregate.reasoning),
              responseId: aggregate.responseId,
              text: aggregate.text,
              // assembler 是流式参数归一化的唯一所有者；
              // model-io 复用其快照，避免二次解析、重复 warn 和诊断结果漂移。
              toolCalls: input.normalizedToolCalls,
              toolResults: normalizeToolResults(syntheticResult, input.normalizedToolCalls),
              sources: normalizeSources(syntheticResult),
              usage: normalizeUsage(aggregate.usage),
            }
          : undefined,
        sessionId: stringMetadata(metadata.sessionId),
        querySource: stringMetadata(metadata.querySource),
        startedAt: new Date(input.startedAt).toISOString(),
        traceId: stringMetadata(metadata.traceId),
        turnId: stringMetadata(metadata.turnId),
        type: "model_io",
      },
      input.debugDir,
      input.isDev,
      input.modelIoFullRetentionEnabled,
    );
  } catch {
    // Model I/O debug logging must never affect the model request path.
  }
}

function buildFallbackRequestBodyFromOptions(input: {
  options: AiSdkGenerateTextOptions | AiSdkStreamTextOptions;
  resolved: ResolvedAiSdkModel;
  stream: boolean;
}): Record<string, unknown> {
  const options = input.options as Record<string, unknown>;
  return removeUndefined({
    // 失败路径经常拿不到 AI SDK 暴露的 raw request.body。此处记录送入
    // AI SDK 的完整 payload 快照，方便排查 provider 400 的 messages/tools 结构。
    bodySource: "ai_sdk_options",
    experimental_include: options.experimental_include,
    frequencyPenalty: options.frequencyPenalty,
    maxOutputTokens: options.maxOutputTokens,
    messages: options.messages,
    model: input.resolved.modelId,
    presencePenalty: options.presencePenalty,
    providerOptions: options.providerOptions,
    seed: options.seed,
    stopSequences: options.stopSequences,
    stream: input.stream,
    temperature: options.temperature,
    toolChoice: options.toolChoice,
    tools: options.tools,
    topK: options.topK,
    topP: options.topP,
  });
}

interface StreamModelIOAggregate {
  finishReason?: unknown;
  providerMetadata?: unknown;
  reasoning?: unknown;
  requestBody?: unknown;
  responseBody?: unknown;
  responseHeaders?: unknown;
  responseId?: unknown;
  responseModelId?: unknown;
  sources?: unknown;
  text?: unknown;
  toolResults?: unknown;
  usage?: Parameters<typeof normalizeUsage>[0];
}

// StreamTextResult 的聚合字段都是 promise，逐个 best-effort 解析(失败回退 undefined)。
async function resolveStreamModelIOAggregate(
  result: AiSdkStreamTextResult,
): Promise<StreamModelIOAggregate> {
  const streamResult = result as unknown as {
    text?: Promise<unknown>;
    reasoning?: Promise<unknown>;
    finishReason?: Promise<unknown>;
    totalUsage?: Promise<unknown>;
    usage?: Promise<unknown>;
    toolResults?: Promise<unknown>;
    sources?: Promise<unknown>;
    providerMetadata?: Promise<unknown>;
    request?: Promise<unknown>;
    response?: Promise<unknown>;
  };

  const [
    text,
    reasoning,
    finishReason,
    totalUsage,
    usage,
    toolResults,
    sources,
    providerMetadata,
    request,
    response,
  ] = await Promise.all([
    settleModelIOValue(streamResult.text),
    settleModelIOValue(streamResult.reasoning),
    settleModelIOValue(streamResult.finishReason),
    settleModelIOValue(streamResult.totalUsage),
    settleModelIOValue(streamResult.usage),
    settleModelIOValue(streamResult.toolResults),
    settleModelIOValue(streamResult.sources),
    settleModelIOValue(streamResult.providerMetadata),
    settleModelIOValue(streamResult.request),
    settleModelIOValue(streamResult.response),
  ]);

  const requestRecord = (request ?? undefined) as { body?: unknown } | undefined;
  const responseRecord = (response ?? undefined) as
    | { id?: unknown; modelId?: unknown; headers?: unknown; body?: unknown }
    | undefined;

  return {
    text,
    reasoning,
    finishReason,
    usage: (totalUsage ?? usage) as StreamModelIOAggregate["usage"],
    toolResults,
    sources,
    providerMetadata,
    requestBody: requestRecord?.body,
    responseBody: responseRecord?.body,
    responseHeaders: responseRecord?.headers,
    responseId: responseRecord?.id,
    responseModelId: responseRecord?.modelId,
  };
}

function modelIOReasoningText(reasoning: unknown): string | undefined {
  if (!Array.isArray(reasoning)) {
    return undefined;
  }

  const text = normalizeReasoning(reasoning)
    ?.map((part) => part.text)
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return text && text.length > 0 ? text : undefined;
}

// 流中途被 abort 后，AI SDK 的 request/response 聚合 promise 既不 resolve 也不 reject
// （只有流正常读完或流级报错才会 settle），无限 await 会把 runner-stream 的 catch 挂死，
// turn 永不结束、activeAbortController 永不释放，session 从此拒绝一切新 prompt。
// 诊断记录是 best-effort：调用方已 abort 时直接跳过聚合，其余失败限时等待。
const FAILED_STREAM_AGGREGATE_TIMEOUT_MS = 1_000;

async function resolveFailedStreamModelIOAggregate(
  result: AiSdkStreamTextResult,
  abortSignal?: AbortSignal,
): Promise<StreamModelIOAggregate> {
  if (abortSignal?.aborted) {
    // 用户 Stop：让失败路径立即走完，request body 由 fallback 快照兜底。
    return {};
  }
  const streamResult = result as unknown as {
    request?: Promise<unknown>;
    response?: Promise<unknown>;
  };
  const [request, response] = await Promise.all([
    settleModelIOValueWithTimeout(streamResult.request, FAILED_STREAM_AGGREGATE_TIMEOUT_MS),
    settleModelIOValueWithTimeout(streamResult.response, FAILED_STREAM_AGGREGATE_TIMEOUT_MS),
  ]);
  const requestRecord = (request ?? undefined) as { body?: unknown } | undefined;
  const responseRecord = (response ?? undefined) as
    | { id?: unknown; modelId?: unknown; headers?: unknown; body?: unknown }
    | undefined;

  return {
    requestBody: requestRecord?.body,
    responseBody: responseRecord?.body,
    responseHeaders: responseRecord?.headers,
    responseId: responseRecord?.id,
    responseModelId: responseRecord?.modelId,
  };
}

async function settleModelIOValue<T>(value: Promise<T> | T | undefined): Promise<T | undefined> {
  try {
    return await value;
  } catch {
    return undefined;
  }
}

// 用户 stop / v4 sendQueuedNow 抢占会 abort 当前流式请求；此时
// AI SDK StreamTextResult 的 request/response 聚合 promise 永不 settle——流被中途放弃，
// 聚合要等 fullStream 关闭才 resolve，而关闭 iterator 的 finally（runner-stream.ts）
// 又排在本 await 之后，形成循环等待。settleModelIOValue 只兜 reject 不兜「不 settle」，
// 导致 runStreamText 的 catch 永远不结束：TurnCancelled 无法上抛、turn 永不收口、
// record.activeAbortController 不释放、UI 的 stop（canStop）永久失效
// （e2e 复现：conversation-session-v4-vertical-slice / v4-sendnow）。
// 失败路径的 model-io 记录必须有界等待：超时按「值不可得」处理，绝不阻塞错误传播。
async function settleModelIOValueWithTimeout<T>(
  value: Promise<T> | T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    });
    return await Promise.race([settleModelIOValue(value), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// 归一化 ZCODE_RUNTIME_ENV；未设置时返回 undefined,由调用方按生产处理。
function normalizeRuntimeEnv(env: EnvRecord): string | undefined {
  return normalizeZCodeRuntimeEnv(env[ZCODE_RUNTIME_ENV_KEY]);
}
