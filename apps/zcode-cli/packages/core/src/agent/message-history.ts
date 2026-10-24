import type {
  RuntimeMessageMessageEntry,
  RuntimeAttachmentEntry,
} from "./message-history-contract.js";
import { realUserRuntimeMetadata } from "./message-history-entries.js";
export { toModelToolCall } from "./message-history-contract.js";
import type { Model } from "@zcode/contracts";
import type { ModelMessageContent } from "@zcode/contracts";
import type { TokenUsageInfo } from "@zcode/contracts";
import type { SystemReminderSource } from "../system-reminder/source.js";
import { CacheStats } from "./message-history-contract.js";
import type { MessageHistory } from "./message-history-contract.js";
import type { ModelInputMessage } from "./message-history-contract.js";
import type { ReasoningContentInput } from "./message-history-contract.js";
import type { RuntimeMessageEntry } from "./message-history-contract.js";
import type { RuntimeMessageMetadata } from "./message-history-contract.js";
import type { ToolCallInput } from "./message-history-contract.js";
import { cloneEntryInput } from "./message-history-entries.js";
import { cloneReasoningBlock } from "./message-history-entries.js";
import { cloneRuntimeMessageEntry } from "./message-history-entries.js";
import { cloneTokenUsageInfo } from "./message-history-entries.js";
import { countContextPrefixMessages } from "./message-history-entries.js";
import { createRuntimeToolResultEntry } from "./message-history-entries.js";
import { createRuntimeUserEntry } from "./message-history-entries.js";
import { systemReminderAttachmentEntry } from "./message-history-entries.js";
import type { ModelCallWrapper } from "@zcode/contracts";
import type { FilePart } from "@zcode/contracts";
import type { ModelMessageContentBlock } from "@zcode/contracts";
import { buildPromptAttachmentReminderBodies } from "../system-reminder/prompt-attachment.js";
import type { PromptAttachmentReminderInput } from "../system-reminder/prompt-attachment.js";
// ============================================================
// Message History - Maintains conversation context across turns
// ============================================================

export type {
  CacheStats,
  MessageHistory,
  ModelInputMessage,
  ReasoningContentInput,
  RuntimeAttachmentEntry,
  RuntimeMessageEntry,
  RuntimeMessageMessageEntry,
  RuntimeMessageMetadata,
  RuntimeMessageSource,
  ToolCallInput,
} from "./message-history-contract.js";

export {
  cloneModelInputMessage,
  cloneModelMessageContent,
  cloneRuntimeMessageEntry,
  cloneRuntimeMessageMetadata,
  countContextPrefixMessages,
  createRuntimeAssistantEntry,
  createRuntimeToolResultEntry,
  createRuntimeUserEntry,
  invalidateRuntimeTokenUsage,
  isKnownSystemReminderSource,
  isRuntimeAttachmentEntry,
  legacySyntheticRuntimeMetadata,
  realUserRuntimeMetadata,
  systemReminderAttachmentEntry,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
} from "./message-history-entries.js";

// ============================================================
// Message History Implementation
// ============================================================

export class MessageHistoryImpl implements MessageHistory {
  private entries: RuntimeMessageEntry[] = [];
  private cacheStats: CacheStats = {
    totalMessages: 0,
    cachedMessages: 0,
    lastCacheHit: false,
  };

  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void {
    this.entries = [];

    if (typeof systemPromptOrMessages === "string" && systemPromptOrMessages.length > 0) {
      this.entries.push({
        message: {
          role: "system",
          content: systemPromptOrMessages,
        },
      });
    } else if (Array.isArray(systemPromptOrMessages)) {
      this.entries.push(...systemPromptOrMessages.map(cloneEntryInput));
    }

    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void {
    this.entries.push(createRuntimeUserEntry(content, metadata));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAttachment(source: SystemReminderSource, content: string): void {
    this.entries.push(systemReminderAttachmentEntry(source, content));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addEntries(entries: readonly RuntimeMessageEntry[]): void {
    this.entries.push(...entries.map(cloneRuntimeMessageEntry));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void {
    const reasoningBlocks = reasoning?.map((block) => cloneReasoningBlock(block)) ?? [];
    this.entries.push({
      message: {
        role: "assistant",
        content:
          reasoningBlocks.length > 0
            ? [
                ...reasoningBlocks,
                ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
              ]
            : content,
        toolCalls: toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
          ...(tc.modelCallWrapper ? { modelCallWrapper: tc.modelCallWrapper } : {}),
        })),
        ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
      },
      ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
    });
    this.cacheStats.totalMessages = this.entries.length;
  }

  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError = !success,
    modelCallWrapper?: ModelCallWrapper,
  ): void {
    this.entries.push(
      createRuntimeToolResultEntry(toolCallId, toolName, content, isError, modelCallWrapper),
    );
    this.cacheStats.totalMessages = this.entries.length;
  }

  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[] {
    return this.entries;
  }

  toRuntimeEntries(): RuntimeMessageEntry[] {
    return this.entries.map(cloneRuntimeMessageEntry);
  }

  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void {
    this.entries = messages.map(cloneEntryInput);
    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  getMessageCount(): number {
    return this.entries.length;
  }

  getCacheStats(): CacheStats {
    return { ...this.cacheStats };
  }

  setCacheHit(tokens?: number): void {
    this.cacheStats.lastCacheHit = true;
    this.cacheStats.cacheReadTokens = tokens;
    // Mark all messages as potentially cached
    this.cacheStats.cachedMessages = this.entries.length;
  }

  setCacheMiss(): void {
    this.cacheStats.lastCacheHit = false;
    this.cacheStats.cacheReadTokens = undefined;
    this.cacheStats.cachedMessages = countContextPrefixMessages(this.entries);
  }

  reset(): void {
    const contextPrefixMessages = this.entries.slice(0, countContextPrefixMessages(this.entries));
    this.entries = contextPrefixMessages.map(cloneRuntimeMessageEntry);
    this.cacheStats = {
      totalMessages: contextPrefixMessages.length,
      cachedMessages: contextPrefixMessages.length,
      lastCacheHit: false,
    };
  }
}

// ============================================================
// Factory
// ============================================================

export function createMessageHistory(): MessageHistory {
  return new MessageHistoryImpl();
}

/** 用户附件的已解析内容及持久化来源；不依赖 runtime 或文件读取。 */
export type UserMessageAttachment = Pick<FilePart, "filename" | "mime" | "source" | "metadata"> & {
  contentBlock: ModelMessageContentBlock;
};

// 首发、队列消费和恢复曾分别组装，导致正文、PDF、路径引用顺序及文本附件语义漂移。
// 统一在消息历史边界组装；调用方只负责解析内容，不再各自分组。
export function buildUserMessageEntries(
  input: ModelMessageContent,
  attachments: readonly UserMessageAttachment[],
): [RuntimeMessageMessageEntry, ...RuntimeAttachmentEntry[]] {
  const realUserBlocks: ModelMessageContentBlock[] = [];
  const pastedImageBlocks: ModelMessageContentBlock[] = [];
  const promptAttachmentEntries: RuntimeAttachmentEntry[] = [];

  for (const attachment of attachments) {
    if (isPastedInlineImageAttachment(attachment)) {
      pastedImageBlocks.push(attachment.contentBlock);
      continue;
    }

    const promptAttachmentInput = promptAttachmentInputForResolvedAttachment(attachment);
    if (promptAttachmentInput) {
      const reminderBody = buildPromptAttachmentReminderBodies(promptAttachmentInput).join("\n");
      promptAttachmentEntries.push(
        systemReminderAttachmentEntry("prompt_attachment", reminderBody),
      );
      continue;
    }

    if (isFailedTextAttachmentPlaceholder(attachment)) {
      continue;
    }

    realUserBlocks.push(attachment.contentBlock);
  }

  const blocks: ModelMessageContentBlock[] = [];
  if (typeof input === "string") {
    if (input.length > 0) blocks.push({ type: "text", text: input });
  } else {
    blocks.push(...input.filter((block) => block.type !== "text" || block.text.length > 0));
  }
  blocks.push(...realUserBlocks, ...pastedImageBlocks);

  return [
    {
      message: {
        role: "user",
        content: normalizeRealUserContent(blocks),
      },
      metadata: realUserRuntimeMetadata(),
    },
    ...promptAttachmentEntries,
  ];
}

function normalizeRealUserContent(
  blocks: readonly ModelMessageContentBlock[],
): ModelMessageContent {
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && blocks[0]!.type === "text") {
    return blocks[0]!.text;
  }
  return blocks.map((block) => ({ ...block })) as ModelMessageContentBlock[];
}

export function isPastedInlineImageAttachment(attachment: UserMessageAttachment): boolean {
  if (attachment.contentBlock.type === "image") {
    // 冷恢复会把本地媒体重建为 inline；分组必须使用持久化来源，不能据此把本地图片当成粘贴图片。
    return !attachment.source && attachment.contentBlock.source?.kind === "inline";
  }
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("image/") &&
    /^\[Attached image\/[^:]+: \[image #\d+\]\]$/u.test(attachment.contentBlock.text)
  );
}

function shouldAddReadLikePromptAttachmentReminder(
  attachment: UserMessageAttachment,
): attachment is UserMessageAttachment & {
  contentBlock: Extract<ModelMessageContentBlock, { type: "text" }>;
  source: NonNullable<UserMessageAttachment["source"]>;
} {
  if (attachment.contentBlock.type !== "text") return false;
  if (!attachment.mime.startsWith("text/")) return false;
  if (!attachment.source) return false;
  if (attachment.metadata?.storageKind !== "inline") return false;
  if (
    attachment.metadata?.recoverability !== "provider_ready" &&
    attachment.metadata?.recoverability !== "preview_only"
  ) {
    return false;
  }
  return attachment.metadata?.preview?.text === attachment.contentBlock.text;
}

export function promptAttachmentInputForResolvedAttachment(
  attachment: UserMessageAttachment,
): (PromptAttachmentReminderInput & { content: string; kind: "file" | "inline_text" }) | undefined {
  if (shouldAddReadLikePromptAttachmentReminder(attachment)) {
    return {
      content: attachment.contentBlock.text,
      kind: "file",
      // provider-visible 的 Read 输入要和用户提交的附件引用一致。
      // local file 的 filename 只是展示名；只有缺少 source 时才用它兜底，避免 live/hydrate 轨迹漂移。
      label: attachment.source.text.value ?? attachment.filename,
      preview: attachment.metadata?.preview,
    };
  }

  if (shouldAddInlinePromptAttachmentReminder(attachment)) {
    return {
      content: attachment.contentBlock.text,
      kind: "inline_text",
      label: attachment.filename,
      preview: attachment.metadata?.preview,
    };
  }

  return undefined;
}

function shouldAddInlinePromptAttachmentReminder(
  attachment: UserMessageAttachment,
): attachment is UserMessageAttachment & {
  contentBlock: Extract<ModelMessageContentBlock, { type: "text" }>;
} {
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("text/") &&
    !attachment.source
  );
}

export function isFailedTextAttachmentPlaceholder(attachment: UserMessageAttachment): boolean {
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("text/") &&
    attachment.metadata?.errorCode === "attachment_read_failed"
  );
}
