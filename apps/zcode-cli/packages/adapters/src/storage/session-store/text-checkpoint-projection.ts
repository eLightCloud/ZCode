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

function unsupported(): never {
  throw new TextCheckpointError("unsupported_state");
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
): TextCheckpoint {
  if (
    session.taskType !== "interactive" ||
    session.parentID ||
    session.revert ||
    session.time.compacting ||
    session.time.archived ||
    session.summaryDiffs?.length
  )
    unsupported();
  const selected = entries.filter((entry) => entry.type === SESSION_ENTRY_MODEL_SELECTION);
  if (selected.length !== 1) unsupported();
  for (const entry of entries) {
    if (entry.type === SESSION_ENTRY_MODEL_SELECTION) continue;
    if (entry.type !== SESSION_ENTRY_EXECUTION_STATE) unsupported();
    const state = entry.data as { mode?: unknown; planEnabled?: unknown } | null;
    if (
      !state ||
      !["build", "guarded"].includes(String(state.mode)) ||
      state.planEnabled !== false ||
      Object.keys(state).some((key) => !["mode", "planEnabled"].includes(key))
    )
      unsupported();
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
        if (!empty(metadata)) unsupported();
        portableInfo = { ...rest, anchor: commonAnchor };
      }
      return {
        info: portableInfo,
        parts: parts.map((item) => {
          const { sessionID, messageID, ...rest } = item;
          if (sessionID !== session.id || messageID !== info.id) unsupported();
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
  const parsed = textCheckpointSchema.safeParse({
    format: "zcode.text-checkpoint",
    version: portableMessages.some((message) => message.parts.some((part) => part.type === "file"))
      ? 3
      : portableMessages.some(
            (message) => (message.info as { metadata?: unknown }).metadata !== undefined,
          ) || portableInputs.some((input) => fullIntent(input.payload.conversationInputIntent))
        ? 2
        : 1,
    session: {
      id: session.id,
      traceID: session.traceID,
      slug: session.slug,
      title: session.title,
      version: session.version,
      time: { created: session.time.created, updated: session.time.updated },
    },
    modelSelection: selected[0]!.data,
    modelSelectionEntryId: selected[0]!.id,
    messages: portableMessages,
    inputs: portableInputs,
  });
  if (!parsed.success) unsupported();
  return parsed.data;
}
