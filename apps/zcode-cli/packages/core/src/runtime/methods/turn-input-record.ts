import type { SessionEvent } from "../deps.js";
import type { createAdmittedTurnModel } from "./turn-model-initialization.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import type { MessageId } from "../deps.js";
import type { TraceContext } from "../deps.js";
import { buildRuntimeUserEntriesFromTurn } from "../helpers/index.js";
import { buildUserContentFromTurn } from "../helpers/index.js";
import { runtimeMetadataForSyntheticUserMessageSource } from "../helpers/index.js";
import { throwIfTurnAborted } from "../helpers/index.js";
import type { ExecuteTurnOptions } from "../types.js";
import type { ResolvedTurnAttachment } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { maybeStartSessionTitleGeneration } from "./session-title.js";
import { enforceRequiredPluginEntry } from "./required-plugin.js";
import { SessionEventType } from "../deps.js";

export async function recordTurnUserInput(
  this: AgentRuntimeInternal,
  turnTraceContext: TraceContext,
  options: ExecuteTurnOptions | undefined,
  input: string,
  resolvedAttachments: ResolvedTurnAttachment[],
  userMessageId: MessageId,
  displayInput: string,
  turnAbortSignal: AbortSignal,
  shouldRetryTitleGenerationAfterTurn: boolean,
  modelPreparation: Awaited<ReturnType<typeof createAdmittedTurnModel>>,
  events: SessionEvent[],
) {
  const { creationFailure, creationFallback } = modelPreparation;
  await this.persistPendingModelChangeTimeline(turnTraceContext);
  if (options?.skipInputRecord !== true && options?.inputVisibility === "model-only") {
    const inputSource = options.inputSource ?? "goal-continuation";
    const userContent = buildUserContentFromTurn(input, resolvedAttachments);
    this.messageHistory.addUser(
      userContent,
      runtimeInputMetadata(options.inputPresentation) ??
        runtimeMetadataForSyntheticUserMessageSource(inputSource),
    );
    // /goal 自动续跑是 runtime 注入给模型的内部 user-role 输入，
    // 不是用户在聊天里新发的一条消息。持久化时保留 raw 输入供恢复/排查使用，
    // 但用 model-only 语义阻止 UI-facing snapshot 把它渲染成用户气泡。
    await this.persistSyntheticUserNoticeForSession({
      messageID: userMessageId,
      metadata: {
        ...(options.targetId ? { targetId: options.targetId } : {}),
        ...(options.inputPresentation ? { inputPresentation: options.inputPresentation } : {}),
        visibility: "model-only",
      },
      sessionId: this.sessionId,
      source: inputSource,
      text: input,
      traceContext: turnTraceContext,
      visibility: "model-only",
    });
  } else if (options?.skipInputRecord !== true) {
    this.messageHistory.addEntries(
      buildRuntimeUserEntriesFromTurn(
        withConversationQuotes(
          input,
          options?.intent?.conversationQuotes,
          options?.intent?.botGroupSource,
        ),
        resolvedAttachments,
        {
          browserAmbientContext: options?.browserAmbientContext,
        },
      ).map((entry) => {
        const metadata = runtimeInputMetadata(options?.inputPresentation);
        return entry.kind !== "attachment" && metadata ? { ...entry, metadata } : entry;
      }),
    );
    // /init 和自定义 slash command 会把模型输入展开成较长的内部
    // prompt。模型可见的历史必须使用展开后的 input，但 UI 展示、会话标题和
    // 恢复快照只能展示用户真实提交的原始 query。
    await this.persistUserPrompt(
      userMessageId,
      displayInput,
      resolvedAttachments,
      turnTraceContext,
      {
        intent: options?.intent,
        inputPresentation: options?.inputPresentation,
        sessionInputId: options?.intent?.queueItemId,
        sourceCommandId: options?.inputId,
        ...(options?.epilogueStart === undefined ? {} : { epilogueStart: options.epilogueStart }),
      },
    );
  }
  if (creationFailure) {
    // 已接纳输入已随 TurnStarted 和用户消息落库；不准备 Agent、不生成标题、不请求模型，
    // 终态由下方 catch 统一写入。
    throw creationFailure.error;
  }
  if (creationFallback) {
    // TurnStarted 与用户消息已先落库，continuous/replayable 投影都能把退回事实关联到同一输入行。
    const fallbackEvent = this.createEvent(
      SessionEventType.TurnExecutionModelFallback,
      {
        ...(options?.inputId ? { inputId: options.inputId } : {}),
        reason: creationFallback.reason,
        fromModelSelection: creationFallback.fromModelSelection,
        toModelSelection: creationFallback.toModelSelection,
      },
      turnTraceContext,
    );
    await this.appendEvent(fallbackEvent, turnTraceContext);
    events.push(fallbackEvent);
  }
  // 配置读取曾早于输入展示/持久化，失败会让已发送消息从界面消失。
  // 在原有输入记录后固定本轮定义，错误/取消复用本层收尾，且不启动标题或模型请求。
  await this.prepareAgentDefinitions({
    signal: turnAbortSignal,
    traceContext: turnTraceContext,
  });
  throwIfTurnAborted(turnAbortSignal);
  await enforceRequiredPluginEntry(
    this,
    options?.inputVisibility === "model-only" ? "" : displayInput,
    turnTraceContext,
    turnAbortSignal,
  );
  if (options?.skipInputRecord !== true && options?.inputVisibility !== "model-only") {
    // 修复原因：标题生成以前等主 turn 成功后才启动，用户 stop/cancel 首轮请求时
    // generated title 永远没有机会发起。首条 query 持久化后即可异步生成，避免被主链路取消拖死。
    const titleGenerationStarted = maybeStartSessionTitleGeneration.call(
      this,
      displayInput,
      userMessageId,
      turnTraceContext,
      {
        deferIfProviderRuntimeHeadersRefresh: true,
        offPeakExecutionId: options?.offPeakExecutionId,
      },
    );
    shouldRetryTitleGenerationAfterTurn = !titleGenerationStarted;
  }
  // Plugin reminder 必须在对应 user 消息写入历史和 session store 后再追加：
  // provider 形态因此稳定为 user → system，cold hydration 也按同一因果顺序恢复。
  // 根因：input 可能已经被自定义命令展开，解析它会让命令模板里的 plugin://
  // 凭空获得“用户引用”语义；这里只解析真实持久化的 canonical displayInput。
  // runtime 内部的 model-only continuation 不代表新的用户意图，不重复解析。
  if (options?.inputVisibility !== "model-only") {
    await this.injectPluginReferenceReminderFromTurn(
      displayInput,
      turnTraceContext,
      options?.toolDisallowlist,
    );
  }
  return shouldRetryTitleGenerationAfterTurn;
}
