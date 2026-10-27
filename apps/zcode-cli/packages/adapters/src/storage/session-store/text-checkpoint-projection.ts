import { conversationArtifactUriSchema } from "@zcode/shared";
import { z } from "zod";
import {
  SESSION_ENTRY_EXECUTION_STATE,
  SESSION_ENTRY_MODEL_SELECTION,
  TextCheckpointError,
  textCheckpointSchema,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionInfo,
  type SessionInputRecord,
  type TextCheckpoint,
} from "@zcode/contracts";

export const checkpointOriginSchema = z
  .object({
    missingTitleSource: z.boolean(),
    missingTitleMessageID: z.boolean(),
    title: z.string(),
    titleSource: z.string().nullable(),
    titleMessageID: z.string().nullable(),
  })
  .strict();
function unsupported(cause?: unknown): never {
  throw new TextCheckpointError("unsupported_state", cause === undefined ? undefined : { cause });
}
function empty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
  );
}
function noExtra(value: Record<string, unknown>): void {
  if (Object.values(value).some((item) => item !== undefined)) unsupported();
}
function fullIntent(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && "queueItemId" in value;
}

/** 环境及能力枚举在目标重新生成；其他 synthetic 上下文不能猜测丢弃。 */
function regenerable(message: MessageWithParts): boolean {
  const info = message.info;
  return (
    info.role === "user" &&
    info.synthetic === true &&
    info.semantics?.origin === "agent_runtime" &&
    info.semantics.kind === "system_reminder" &&
    info.semantics.source === "agent_listing_delta"
  );
}

export function projectTextCheckpoint(
  session: SessionInfo,
  messages: MessageWithParts[],
  entries: SessionEntryInfo[],
  inputs: SessionInputRecord[],
  todos?: unknown[],
): TextCheckpoint {
  if (
    !["interactive", "fork"].includes(session.taskType) ||
    (session.revert &&
      (session.revert.kind !== "conversation_rewind" || session.revert.scope !== "conversation")) ||
    session.time.compacting ||
    // 软删除已归原生会话 owner；导出不得把删除会话当成可恢复的活动文本。
    session.time.deleted ||
    session.summaryDiffs?.length
  )
    unsupported();
  const selected = entries.filter((entry) => entry.type === SESSION_ENTRY_MODEL_SELECTION);
  if (selected.length !== 1) unsupported();
  let origin: z.infer<typeof checkpointOriginSchema> | undefined;
  let execution: unknown;
  let branchEffects: unknown;
  const commandFacts: unknown[] = [];
  for (const entry of entries) {
    if (entry.type === SESSION_ENTRY_MODEL_SELECTION) continue;
    if (entry.type === "v4/command_fact") {
      commandFacts.push({ id: entry.id, time: entry.time, data: entry.data });
      continue;
    }
    if (entry.type === "runtime/checkpoint_origin") {
      const parsed = checkpointOriginSchema.safeParse(entry.data);
      if (!parsed.success) unsupported();
      origin = parsed.data;
      continue;
    }
    if (entry.type === "runtime/branch_effects") {
      branchEffects =
        entry.data && typeof entry.data === "object" && "effects" in entry.data
          ? entry.data.effects
          : entry.data;
      continue;
    }
    if (entry.type !== SESSION_ENTRY_EXECUTION_STATE) unsupported();
    const state = entry.data as { mode?: unknown; planEnabled?: unknown } | null;
    if (
      !state ||
      !["build", "guarded"].includes(String(state.mode)) ||
      typeof state.planEnabled !== "boolean" ||
      Object.keys(state).some((key) => !["mode", "planEnabled"].includes(key))
    )
      unsupported();
    execution = { id: entry.id, time: entry.time, data: entry.data };
  }
  const omitted = new Set(messages.filter(regenerable).map((message) => String(message.info.id)));
  const portableMessages = messages
    .filter((message) => !omitted.has(String(message.info.id)))
    .map(({ info, parts }) => {
      const { sessionID: _sessionID, anchor, ...original } = info;
      if (String(info.sessionID) !== String(session.id)) unsupported();
      const commonAnchor = anchor
        ? {
            ...anchor,
            ...(anchor.orderedMessageIds
              ? {
                  orderedMessageIds: anchor.orderedMessageIds.filter(
                    (key) => !omitted.has(String(key)),
                  ),
                }
              : {}),
          }
        : undefined;
      let portableInfo: unknown;
      if (original.role === "user") {
        // 旧轮的可见工具目录与环境均为投影，不是授权；目标从当前配置重新解析。
        const {
          contextSnapshot: _environment,
          tools: _toolProjection,
          metadata,
          ...rest
        } = original;
        portableInfo = { ...rest, anchor: commonAnchor, ...(empty(metadata) ? {} : { metadata }) };
      } else {
        const { path: _sourcePath, metadata, ...rest } = original;
        portableInfo = { ...rest, anchor: commonAnchor, ...(empty(metadata) ? {} : { metadata }) };
      }
      return {
        info: portableInfo,
        parts: parts
          .filter((item) => item.type !== "reasoning")
          .map((item) => {
            const { sessionID, messageID, ...rest } = item;
            if (sessionID !== session.id || messageID !== info.id) unsupported();
            if (item.type === "tool") {
              if (item.state.status !== "completed" && item.state.status !== "error") unsupported();
              const state = { ...item.state };
              const display = state.metadata?.display;
              if (
                display &&
                typeof display === "object" &&
                "kind" in display &&
                display.kind === "bash_output" &&
                "outputPath" in display &&
                display.outputPath
              )
                unsupported();
              if (
                state.metadata?.serialization &&
                typeof state.metadata.serialization === "object"
              ) {
                const serialization = {
                  ...(state.metadata.serialization as Record<string, unknown>),
                };
                const uri = serialization.artifactUri ?? serialization.artifactPath;
                if (
                  serialization.artifactPath !== undefined &&
                  !conversationArtifactUriSchema.safeParse(uri).success
                )
                  unsupported();
                if (uri) {
                  serialization.artifactUri = uri;
                  serialization.artifactPath = uri;
                }
                state.metadata = { ...state.metadata, serialization };
              }
              if (state.status === "completed" && state.attachments)
                state.attachments = state.attachments.map((file) => {
                  const { sessionID: owner, messageID: message, ...portable } = file;
                  if (owner !== session.id || message !== info.id) unsupported();
                  return portable as typeof file;
                });
              return { ...rest, state };
            }
            return rest;
          }),
      };
    });
  const portableInputs = inputs.map((input) => {
    const { sessionID: _sessionID, payload, ...rest } = input;
    if (input.sessionID !== session.id) unsupported();
    const canonical = payload.conversationInputIntent;
    if (fullIntent(canonical)) {
      return { ...rest, payload };
    }
    const { text, conversationInputIntent, intent, ...extra } = payload;
    noExtra(extra);
    if (conversationInputIntent !== undefined && intent !== undefined) unsupported();
    const source = conversationInputIntent ?? intent;
    // 输入原样经唯一 codec 校验；不能只取 sourceCommandId 丢掉 V4 顺序与去重事实。
    if (source && (typeof source !== "object" || Array.isArray(source))) unsupported();
    const fact = source as Record<string, unknown> | undefined;
    return {
      ...rest,
      payload: {
        text,
        ...(fact ? { conversationInputIntent: fact } : {}),
      },
    };
  });
  const preserveMissingTitle = origin?.title === session.title;
  const titleSource =
    preserveMissingTitle &&
    origin?.missingTitleSource &&
    origin.titleSource === (session.titleSource ?? null)
      ? undefined
      : session.titleSource;
  const titleMessageID =
    preserveMissingTitle &&
    origin?.missingTitleMessageID &&
    origin.titleMessageID === (session.titleMessageID ?? null)
      ? undefined
      : session.titleMessageID;
  const parsed = textCheckpointSchema.safeParse({
    format: "zcode.text-checkpoint",
    version:
      commandFacts.length ||
      session.parentID ||
      session.revert ||
      titleSource ||
      session.lastOutcome ||
      branchEffects ||
      execution ||
      todos?.length ||
      // 失败消息即使没有 execution entry 也必须沿 v4，不能降成拒绝错误事实的旧格式。
      messages.some(
        (m) =>
          m.info.role === "assistant" &&
          (m.info.error || m.info.finish !== "stop" || m.info.time.completed === undefined),
      ) ||
      portableMessages.some(
        (m) =>
          m.parts.some((p) => ["tool", "compaction"].includes(p.type)) ||
          (m.info as { synthetic?: boolean; summary?: unknown }).synthetic ||
          (m.info as { summary?: unknown }).summary,
      )
        ? 4
        : portableMessages.some((message) => message.parts.some((part) => part.type === "file"))
          ? 3
          : portableMessages.some(
                (message) => (message.info as { metadata?: unknown }).metadata !== undefined,
              ) || portableInputs.some((input) => fullIntent(input.payload.conversationInputIntent))
            ? 2
            : 1,
    session: {
      id: session.id,
      traceID: session.traceID,
      ...(session.parentID ? { parentID: session.parentID, taskType: session.taskType } : {}),
      ...(session.revert ? { revert: session.revert } : {}),
      ...(titleSource ? { titleSource } : {}),
      ...(titleMessageID ? { titleMessageID } : {}),
      ...(session.lastOutcome ? { lastOutcome: session.lastOutcome } : {}),
      ...(session.lastOutcomeInputId
        ? { lastOutcomeInputId: session.lastOutcomeInputId, lastOutcomeAt: session.lastOutcomeAt }
        : {}),
      slug: session.slug,
      title: session.title,
      version: session.version,
      time: { created: session.time.created, updated: session.time.updated },
    },
    modelSelection: selected[0]!.data,
    modelSelectionEntryId: selected[0]!.id,
    messages: portableMessages,
    inputs: portableInputs,
    ...(execution ? { execution } : {}),
    ...(branchEffects ? { branchEffects } : {}),
    ...(commandFacts.length ? { commandFacts } : {}),
    ...(todos?.length ? { todos } : {}),
  });
  if (!parsed.success) unsupported(parsed.error);
  return parsed.data;
}
