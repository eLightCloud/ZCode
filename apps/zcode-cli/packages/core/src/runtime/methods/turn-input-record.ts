import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";

import { withConversationQuotes } from "../helpers/conversation-quotes.js";

import type { MessageId, TraceContext } from "../deps.js";

import {
  buildRuntimeUserEntriesFromTurn,
  buildUserContentFromTurn,
  runtimeMetadataForSyntheticUserMessageSource,
  throwIfTurnAborted,
} from "../helpers/index.js";

import type { ExecuteTurnOptions, ResolvedTurnAttachment } from "../types.js";

import type { AgentRuntimeInternal } from "../internal.js";

import { maybeStartSessionTitleGeneration } from "./session-title.js";

import { enforceRequiredPluginEntry } from "./required-plugin.js";

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
) {
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
