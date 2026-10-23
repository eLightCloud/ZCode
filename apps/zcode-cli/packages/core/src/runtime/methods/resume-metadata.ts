import { SessionEventType } from "../deps.js";

import type {
  EnvInfo,
  MessageWithParts,
  SessionEvent,
  SessionInfo,
  SessionTitleSource,
  ToolSchedule,
  TraceContext,
  TurnState,
} from "../deps.js";

import type { AgentRuntimeInternal } from "../internal.js";

export function toScheduleState(
  this: AgentRuntimeInternal,
  schedule: ToolSchedule,
): TurnState["scheduledTools"] {
  return {
    items: schedule.items.map((item) => ({
      toolCallId: item.toolCallId,
      dependencies: item.dependencies,
      canRunParallel: item.canRunParallel,
    })),
    parallelGroups: schedule.parallelGroups,
    executionOrder: schedule.executionOrder,
  };
}

export async function syncPersistedSessionTitleForResume(
  this: AgentRuntimeInternal,
  input: {
    restoredEvents: SessionEvent[];
    session: SessionInfo;
    traceContext: TraceContext;
  },
): Promise<void> {
  const title = input.session.title.trim();
  if (!title) return;
  const source = input.session.titleSource ?? "generated";
  if (hasRestoredTitleEvent(input.restoredEvents, title, source)) return;

  // fork child 创建时 title 已写进 sessionStore，但复制历史不会复制父会话的
  // SessionTitleUpdated 事件。v4 live 投影只消费事件流，缺这条事件就会把列表标题降级成"新任务"。
  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        previousTitle: "",
        source,
        title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

export function hasRestoredTitleEvent(
  events: readonly SessionEvent[],
  title: string,
  source: SessionTitleSource,
): boolean {
  return events.some((event) => {
    if (event.type !== SessionEventType.SessionTitleUpdated) return false;
    const payload = event.payload as { source?: unknown; title?: unknown };
    return payload.title === title && payload.source === source;
  });
}

export function extractPersistedEnvInfo(messages: MessageWithParts[]): EnvInfo | undefined {
  for (const message of messages) {
    if (message.info.role !== "user") {
      continue;
    }

    const envInfo = message.info.contextSnapshot?.envInfo;
    if (envInfo) {
      return envInfo;
    }
  }

  return undefined;
}
