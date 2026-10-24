import {
  portableMessageInfoSchema as messageInfo,
  portableMessagePartSchema as part,
  portableModelSelectionSchema as selection,
  portableForkOriginSchema as forkOrigin,
} from "./text-message-facts.js";
import { z } from "zod";
import { CompactTimelineStatus } from "../compact/index.js";
import type { ProjectId, SessionId, WorkspaceId } from "./shared.js";
import {
  portableFilePayload,
  portableFileMetadata,
  portableFileIntent,
} from "./text-input-facts.js";
import {
  conversationEffectSchema,
  type ConversationEffect,
  conversationArtifactUriSchema,
  conversationSessionIdSchema,
} from "@zcode/shared";
import { commandAckSchema, type CommandAck } from "@zcode/shared/zcode-protocol-v4";

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();
const forkTarget = z
  .object({
    productTurnId: id,
    transcriptTurnId: id,
    orderedMessageIds: z.array(id),
    boundaryMessageId: id,
  })
  .strict();
const commandFact = z
  .object({
    id,
    time: z.object({ created: timestamp, updated: timestamp }).strict(),
    data: z
      .object({
        source: z.enum(["child", "timeline"]),
        ack: z.custom<CommandAck>((value) => {
          const parsed = commandAckSchema.strict().safeParse(value);
          if (!parsed.success || parsed.data.message !== undefined) return false;
          const result = parsed.data.result;
          const original = value as Record<string, unknown>;
          return (
            !result ||
            (["forkAssistant", "createSelectionSideSession", "editUserQuery"].includes(
              result.type,
            ) &&
              original.result !== null &&
              typeof original.result === "object" &&
              Object.keys(original.result).every((key) =>
                ["type", "sessionId", "disposition", "reasonCode"].includes(key),
              ))
          );
        }),
        metadata: z
          .object({
            forkOrigin: forkOrigin.optional(),
            forkTarget: forkTarget.optional(),
            parentSessionId: id.optional(),
            sourceCommandId: id.optional(),
            lifecycleStatus: z.enum(["success", "failed", "cancelled"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();
const input = z
  .object({
    id,
    kind: id,
    delivery: z.enum(["startNow", "guide", "queue"]),
    payload: portableFilePayload,
    admittedSequence: timestamp,
    promotedSequence: timestamp.optional(),
    promotedMessageID: id.optional(),
    status: z.enum(["promoted", "cancelled", "discarded", "failed"]),
    statusReason: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .optional(),
    time: z.object({ created: timestamp, updated: timestamp }).strict(),
  })
  .strict();

/** 静止文本严格子集；不含路径、环境、凭据、权限或任意 metadata。 */
export const textCheckpointSchema = z
  .object({
    format: z.literal("zcode.text-checkpoint"),
    version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    session: z
      .object({
        id: z.custom<string>((value) => conversationSessionIdSchema.safeParse(value).success),
        traceID: id.optional(),
        taskType: z.enum(["interactive", "fork"]).optional(),
        parentID: id.optional(),
        titleSource: z.enum(["default", "first_input", "generated", "custom"]).optional(),
        titleMessageID: id.optional(),
        lastOutcome: z.enum(["completed", "error", "interrupted"]).optional(),
        lastOutcomeInputId: id.optional(),
        lastOutcomeAt: timestamp.optional(),
        revert: z
          .object({
            messageID: id,
            partID: id.optional(),
            kind: z.literal("conversation_rewind"),
            scope: z.literal("conversation"),
            targetMessageID: id.optional(),
            createdMessageID: id.optional(),
            keptMessageIDs: z.array(id).optional(),
            branchCutAfterMessageID: id.optional(),
            branchGeneration: timestamp.optional(),
          })
          .strict()
          .optional(),
        slug: id,
        title: z.string(),
        version: id,
        time: z.object({ created: timestamp, updated: timestamp }).strict(),
      })
      .strict(),
    modelSelection: selection,
    modelSelectionEntryId: id,
    messages: z.array(z.object({ info: messageInfo, parts: z.array(part).min(1) }).strict()).min(1),
    inputs: z.array(input),
    branchEffects: z
      .array(
        z.custom<ConversationEffect>((value) => conversationEffectSchema.safeParse(value).success),
      )
      .max(1000)
      .optional(),
    commandFacts: z.array(commandFact).optional(),
    execution: z
      .object({
        id,
        time: z.object({ created: timestamp, updated: timestamp }).strict(),
        data: z.object({ mode: z.enum(["build", "guarded"]), planEnabled: z.boolean() }).strict(),
      })
      .strict()
      .optional(),
    todos: z
      .array(
        z
          .object({
            content: z.string(),
            status: z.enum(["pending", "in_progress", "completed"]),
            priority: z.enum(["high", "medium", "low"]),
            position: timestamp,
            created: timestamp,
            updated: timestamp,
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const extended =
      value.commandFacts !== undefined ||
      value.session.parentID !== undefined ||
      value.session.revert !== undefined ||
      value.session.titleSource !== undefined ||
      value.session.lastOutcome !== undefined ||
      value.branchEffects !== undefined ||
      value.execution !== undefined ||
      value.todos !== undefined ||
      value.inputs.some((input) => {
        const intent = input.payload.conversationInputIntent;
        return (
          intent &&
          "kind" in intent &&
          (intent.kind === "compact" ||
            intent.planEnabled === true ||
            intent.delivery.admitted === "guide")
        );
      }) ||
      value.messages.some(
        (m) =>
          m.info.summary !== undefined ||
          (m.info.role === "user" && (m.info.synthetic || m.info.source)) ||
          (m.info.role === "assistant" && (m.info.planEnabled || m.info.finish !== "stop")) ||
          m.parts.some(
            (p) =>
              p.type === "tool" ||
              p.type === "compaction" ||
              (p.type === "text" && (p.synthetic || p.ignored)),
          ),
      );
    if (
      value.version < 4 &&
      (value.messages.length < 2 ||
        value.messages.some(
          (message) =>
            message.info.role === "assistant" &&
            (message.info.time.completed === undefined ||
              !message.info.finish ||
              message.info.error),
        ))
    )
      context.addIssue({ code: "custom", message: "Unsettled legacy message" });
    if (value.version < 4 && extended)
      context.addIssue({ code: "custom", message: "Extended history requires format v4" });
    const refs = checkpointArtifactUris(value);
    if (
      (value.version < 3 && refs.length > 0) ||
      refs.some((uri) => uri.split("/")[2] !== value.session.id)
    )
      context.addIssue({
        code: "custom",
        message: "Registered same-session files require format v3",
      });
    if (
      value.messages.some((message) =>
        message.parts.some(
          (part) => part.type === "file" && part.url !== part.metadata.artifactUri,
        ),
      )
    )
      context.addIssue({ code: "custom", message: "Inconsistent native artifact identity" });
    if (
      value.version === 1 &&
      (value.messages.some(
        (message) => message.info.role === "user" && message.info.metadata !== undefined,
      ) ||
        value.inputs.some(
          (input) =>
            input.payload.conversationInputIntent &&
            "queueItemId" in input.payload.conversationInputIntent,
        ))
    )
      context.addIssue({ code: "custom", message: "V4 input facts require format v2" });
    const seen = new Set<string>();
    const allMessages = new Map(value.messages.map((message) => [message.info.id, message.info]));
    const issue = (reason = "Invalid checkpoint identity") =>
      context.addIssue({ code: "custom", message: reason });
    const unique = (key: string) => {
      if (seen.has(key)) issue("Duplicate checkpoint identity");
      seen.add(key);
    };
    const ref = (key: string | undefined) => {
      if (key && !allMessages.has(key)) issue("Unresolved checkpoint message reference");
    };
    for (const fact of value.commandFacts ?? []) unique(`entry:${fact.id}`);
    for (const [index, { info, parts }] of value.messages.entries()) {
      if (info.role === "user" && info.metadata && "conversationInputIntent" in info.metadata) {
        const intent = (info.metadata as z.infer<typeof portableFileMetadata>)
          .conversationInputIntent;
        if (
          parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("") !== intent.text ||
          (info.anchor?.sourceCommandId !== undefined &&
            info.anchor.sourceCommandId !== intent.sourceCommandId)
        )
          issue();
      }
      unique(`message:${info.id}`);
      if (value.version < 4 && info.role !== (index % 2 === 0 ? "user" : "assistant")) issue();
      const nativeTimeline =
        info.semantics?.origin === "system" &&
        info.semantics.kind === "timeline_event" &&
        info.semantics.providerVisibility === "hidden" &&
        parts.every((part) => part.type === "timeline" || part.type === "compaction");
      // 原生维护 timeline 的 parent 是最近消息，可为 assistant 或首次记录自身；模型回答仍必须关联先前 user。
      if (
        info.role === "assistant" &&
        (value.version < 4
          ? info.parentID !== value.messages[index - 1]?.info.id
          : nativeTimeline
            ? info.parentID !== info.id &&
              !value.messages.slice(0, index).some((m) => m.info.id === info.parentID)
            : !value.messages
                .slice(0, index)
                .some((m) => m.info.id === info.parentID && m.info.role === "user"))
      )
        issue("Assistant parent is outside the earlier native history");
      if (
        info.role === "assistant" &&
        ["completed", "failed", "interrupted", "skipped"].includes(info.finish ?? "") &&
        !nativeTimeline
      )
        issue("System timeline finish on a model response");
      if (value.version < 4 && !parts.some((item) => item.type === "text")) issue();
      for (const part of parts)
        if (part.type === "compaction") {
          ref(part.tail_start_id);
          ref(part.summaryMessageId);
          if (!part.compactBoundary && !part.timelineStatus)
            issue("Compact has no settled boundary or timeline");
          if (
            part.timelineStatus === CompactTimelineStatus.Started ||
            part.timelineStatus === CompactTimelineStatus.Retrying
          )
            issue("Compact is still running");
          ref(part.compactBoundary?.lastSummarizedMessageId);
          for (const key of part.compactBoundary?.summaryMessageIds ?? []) ref(key);
        }
      ref(info.anchor?.boundaryMessageId);
      for (const key of info.anchor?.orderedMessageIds ?? []) ref(key);
      for (const item of parts) {
        unique(`part:${item.id}`);
        if (item.type === "tool" && item.state.status === "completed") {
          const serialized = item.state.metadata.serialization;
          if (
            serialized?.artifactPath &&
            (serialized.artifactPath !== serialized.artifactUri ||
              !conversationArtifactUriSchema.safeParse(serialized.artifactUri).success)
          )
            issue();
          for (const file of item.state.attachments ?? []) unique(`part:${file.id}`);
          for (const block of item.state.metadata.modelContentLayout ?? [])
            if (
              block.type === "attachment" &&
              block.attachmentIndex >= (item.state.attachments?.length ?? 0)
            )
              issue();
        }
      }
    }
    const lastReal = value.messages.findLastIndex(
      (message) =>
        message.info.role === "user" &&
        !message.info.synthetic &&
        !message.info.summary &&
        message.info.visibility !== "model-only" &&
        message.info.semantics?.kind !== "compact_summary",
    );
    const realInfo = value.messages[lastReal]?.info;
    let latestInput =
      realInfo?.anchor?.sourceCommandId ??
      (realInfo?.role === "user" &&
      realInfo.metadata &&
      "conversationInputIntent" in realInfo.metadata
        ? (realInfo.metadata as z.infer<typeof portableFileMetadata>).conversationInputIntent
            .sourceCommandId
        : undefined);
    for (const message of value.messages.slice(lastReal))
      for (const part of message.parts) {
        if (part.type === "timeline" && part.sourceCommandId) latestInput = part.sourceCommandId;
        if (message.info.anchor?.sourceCommandId) latestInput = message.info.anchor.sourceCommandId;
      }
    if (
      value.session.lastOutcomeInputId &&
      latestInput &&
      value.session.lastOutcomeInputId !== latestInput
    )
      issue("Terminal outcome does not match the latest input");
    const terminalFailed =
      value.session.lastOutcomeInputId === latestInput &&
      latestInput !== undefined &&
      value.session.lastOutcomeAt !== undefined &&
      ["error", "interrupted"].includes(value.session.lastOutcome ?? "");
    if (
      value.version === 4 &&
      lastReal >= 0 &&
      !terminalFailed &&
      !value.messages
        .slice(lastReal + 1)
        .some(
          (message) =>
            message.info.role === "assistant" &&
            (message.info.error ||
              ["stop", "length", "error", "cancelled"].includes(message.info.finish ?? "")),
        )
    )
      issue("Latest real input has no terminal result");

    ref(value.session.titleMessageID);
    if (value.session.revert) {
      const revert = value.session.revert;
      ref(revert.messageID);
      ref(revert.targetMessageID);
      ref(revert.createdMessageID);
      ref(revert.branchCutAfterMessageID);
      for (const key of revert.keptMessageIDs ?? []) ref(key);
    }
    for (const item of value.inputs) {
      const intent = item.payload.conversationInputIntent;
      // Ledger admittedSequence and V4 admissionSeq are different native sequences.
      // Preserve both; terminal status, not the old intent dispatch hint, prevents replay.
      if (
        intent &&
        "queueItemId" in intent &&
        (intent.text !== item.payload.text || intent.queueItemId !== item.id)
      )
        issue();
      unique(`input:${item.id}`);
      ref(item.promotedMessageID);
      unique(`admission:${item.admittedSequence}`);
      if (item.status === "promoted") {
        if (
          !item.promotedMessageID ||
          allMessages.get(item.promotedMessageID)?.role !== "user" ||
          item.promotedSequence === undefined
        )
          issue();
      } else if (item.promotedMessageID !== undefined || item.promotedSequence !== undefined)
        issue();
    }
    if (
      value.messages[0]?.info.role !== "user" ||
      (value.version < 4 && value.messages.at(-1)?.info.role !== "assistant")
    )
      issue();
  });

export type TextCheckpoint = z.infer<typeof textCheckpointSchema>;
export function checkpointArtifactUris(value: {
  messages: Array<{
    info: {
      role: string;
      metadata?: unknown;
    };
    parts: Array<{
      type: string;
      url?: string;
      state?: {
        status: string;
        attachments?: Array<{ url: string }>;
        metadata?: { serialization?: { artifactUri?: string; artifactPath?: string } };
      };
    }>;
  }>;
  inputs: Array<{
    payload: {
      conversationInputIntent?: {
        sourceCommandId: string;
        attachments?: Array<{ ref: string; previewRef?: string }>;
      };
      attachments?: Array<{ ref: string; previewRef?: string }>;
    };
  }>;
}) {
  const refs = new Set<string>();
  const add = (items: Array<{ ref: string; previewRef?: string }> | undefined) => {
    for (const item of items ?? []) {
      refs.add(item.ref);
      if (item.previewRef) refs.add(item.previewRef);
    }
  };
  for (const message of value.messages) {
    for (const part of message.parts) {
      if (part.type === "file" && part.url) refs.add(part.url);
      if (part.type === "tool" && part.state?.status === "completed") {
        for (const file of part.state.attachments ?? []) refs.add(file.url);
        const uri = part.state.metadata?.serialization?.artifactUri;
        if (uri) refs.add(uri);
      }
    }
    const metadata = message.info.metadata;
    if (metadata && typeof metadata === "object" && "conversationInputIntent" in metadata) {
      const intent = portableFileIntent.safeParse(metadata.conversationInputIntent);
      if (intent.success) add(intent.data.attachments);
    }
  }
  for (const item of value.inputs) {
    add(item.payload.attachments);
    add(item.payload.conversationInputIntent?.attachments);
  }
  return [...refs].sort();
}
/** Observations from native tool facts, not semantic parsing of model prose. */
export function checkpointEffectReferences(value: TextCheckpoint): ConversationEffect[] {
  const effects: ConversationEffect[] = [...(value.branchEffects ?? [])];
  for (const message of value.messages)
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const metadata = part.state.metadata ?? part.metadata;
      if (metadata?.effectExecution === "not_started") continue;
      if (metadata?.businessEffect) {
        effects.push(conversationEffectSchema.parse(metadata.businessEffect));
        continue;
      }
      const display = metadata?.display;
      if (
        metadata?.readOnly !== true &&
        (metadata?.sideEffectScope === "network" ||
          metadata?.sideEffectScope === "system" ||
          part.tool === "Bash") &&
        (!display || display.kind !== "mcp_tool")
      ) {
        effects.push({
          server: "native:" + part.tool,
          owner: "native:" + part.tool,
          operation: part.callID,
          requestKey: "unknown",
          receiptUri: "mcp-effect://unconfirmed",
          outcome: "unknown",
        });
        continue;
      }
      if (metadata?.mcpReadOnly === true || !display || display.kind !== "mcp_tool") continue;
      effects.push({
        server: display.serverName,
        owner: display.serverName,
        operation: part.callID,
        requestKey: "unknown",
        receiptUri: "mcp-effect://unconfirmed",
        outcome: "unknown",
      });
    }
  const unique = new Map<string, ConversationEffect>();
  for (const effect of effects) {
    const key = JSON.stringify([effect.server, effect.owner, effect.operation, effect.requestKey]);
    const prior = unique.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(effect))
      throw new TextCheckpointError("unsupported_state");
    unique.set(key, effect);
  }
  return [...unique.values()];
}
export type TextCheckpointErrorCode =
  | "invalid_checkpoint"
  | "unsupported_state"
  | "identity_conflict"
  | "session_not_found"
  | "storage_failure";
export class TextCheckpointError extends Error {
  constructor(
    readonly code: TextCheckpointErrorCode,
    options?: ErrorOptions,
  ) {
    super(`Text checkpoint: ${code}`, options);
    this.name = "TextCheckpointError";
  }
}
export interface TextCheckpointStorePort {
  /** 调用方必须已关闭接纳并收口；一致读不证明 runtime 已静止。 */
  exportTextCheckpoint(input: { sessionID: SessionId }): Promise<TextCheckpoint>;
  /** 原子 create-only；不授权、不执行、不覆盖现有身份。 */
  importTextCheckpoint(input: {
    checkpoint: unknown;
    target: { projectID: ProjectId; workspaceID?: WorkspaceId; directory: string };
  }): Promise<void>;
}
