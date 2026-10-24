import { type MessageId, type SessionId, type CollaborationMode } from "@zcode/contracts";
import {
  zcodeProtocolErrorCodes,
  zcodeSessionForkParamsSchema,
  type ZCodeSessionHistoryTarget,
} from "@zcode/shared";
import { optionalModelSelectionFromString } from "./model-mapper.js";
import {
  ProtocolRequestError,
  assertExpectedRevision,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { runSessionModelConfigMutation } from "../zcode-protocol-v4/model-config-mutation.js";
import { ensureNoActiveTurn } from "./protocol-session-goal.js";
import {
  getPersistedSession,
  snapshot,
  readActiveSessionMessages,
  isUserVisibleSessionMessage,
} from "./protocol-session-snapshot.js";
import { materializeSessionRecord } from "./protocol-session-record.js";

// 原协议 host 的单一职责；复用同一 session record / Core owner，不创建第二状态。
export async function forkSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionForkParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  ensureNoActiveTurn(record, "Cannot fork while a prompt is running");
  const forkTarget = await resolveForkTarget(context, record, params.target);
  const parentMode = record.app.getMode();
  const parentModel = record.app.getModel();
  const parentThoughtLevel = record.app.getThoughtLevel();
  const fork = await record.app.forkFromCheckpoint({
    targetCheckpointId: forkTarget.targetCheckpointId,
    targetMessageId: forkTarget.targetMessageId,
  });
  return await registerForkedSession(context, record, fork, {
    runtimeConfig: {
      mode: parentMode,
      model: parentModel,
      thoughtLevel: parentThoughtLevel,
    },
    inheritLatestTarget: true,
  });
}

/**
 * 已完成 core copy 后只注册 child record。V4 running fork 复用这段宿主生命周期，
 * 但不会进入 forkSession 的 active-turn guard / workspace fork；runtimeConfig 可固定在 fork 点。
 */
export async function registerForkedSession(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  fork: Awaited<ReturnType<ZCodeProtocolSessionRecord["app"]["forkFromCheckpoint"]>>,
  options: {
    runtimeConfig: {
      mode: CollaborationMode;
      model: string;
      thoughtLevel?: string;
      followupMode?: "queue" | "guide";
    };
    inheritLatestTarget: boolean;
  },
) {
  const parentMode = options.runtimeConfig.mode;
  const parentModel = options.runtimeConfig.model;
  const parentThoughtLevel = options.runtimeConfig.thoughtLevel;
  const parentFollowupMode = options.runtimeConfig.followupMode;
  const forkedSession = await getPersistedSession(context, fork.forkedSessionId);
  if (!forkedSession) {
    throw new Error(`Persisted child session not found: ${fork.forkedSessionId}`);
  }
  const forkRecord = await materializeSessionRecord(
    context,
    {
      sessionId: fork.forkedSessionId,
      mode: parentMode,
      // 未绑定父会话也允许复制历史；不能因分叉而选择默认模型或解析空字符串。
      model: optionalModelSelectionFromString(parentModel),
      ...(fork.parentSessionId ? { parentSessionId: fork.parentSessionId } : {}),
      taskType: forkedSession.taskType,
      workspace: record.workspace,
    },
    fork.forkedSessionId as SessionId,
    true,
    { kind: "inherit", parent: record },
  );
  context.assertServing?.();
  context.sessions.set(fork.forkedSessionId, forkRecord);
  await runSessionModelConfigMutation(forkRecord.app, async () => {
    // fork 是父会话运行态的分支；只复制消息的话新 record 会从 workspace 默认值恢复，
    // 于是 fork 后的当前模型/模式会被最新默认设置覆盖。这里在 resume 前显式继承父会话设置。
    if (forkRecord.app.getMode() !== parentMode) {
      await forkRecord.app.setMode(parentMode);
      forkRecord.stateRevision++;
    }
    if (parentModel && forkRecord.app.getModel() !== parentModel) {
      await forkRecord.app.setModel(parentModel);
      forkRecord.stateRevision++;
    }
    if (parentThoughtLevel && forkRecord.app.getThoughtLevel() !== parentThoughtLevel) {
      await forkRecord.app.setThoughtLevel(parentThoughtLevel);
      forkRecord.stateRevision++;
    }
    if (parentFollowupMode && parentFollowupMode !== "queue") {
      await forkRecord.app.setFollowupMode(parentFollowupMode);
      forkRecord.stateRevision++;
    }
  });
  if (options.inheritLatestTarget) {
    await inheritForkedSessionTarget(context, record, forkRecord, fork.forkedSessionId);
  }
  await forkRecord.app.resume();
  return {
    forkedSessionId: fork.forkedSessionId,
    parentSessionId: fork.parentSessionId,
    targetMessageId: fork.targetMessageId,
    targetCheckpointId: fork.targetCheckpointId,
    response: fork.response,
    snapshot: await snapshot(context, forkRecord, forkedSession),
  };
}

async function inheritForkedSessionTarget(
  context: ZCodeProtocolAgentServerContext,
  parentRecord: ZCodeProtocolSessionRecord,
  forkRecord: ZCodeProtocolSessionRecord,
  forkedSessionId: string,
) {
  const parentTarget = await parentRecord.app.readTarget();
  if (!parentTarget || !context.deps.sessionStore) {
    return;
  }
  const existingChildTarget = await context.deps.sessionStore.readTarget({
    sessionID: forkedSessionId as SessionId,
  });
  if (existingChildTarget) {
    return;
  }
  if (!context.deps.sessionStore.cloneTargetForFork) {
    return;
  }

  // core fork 现在会复制 goal state；bootstrap 只保留旧 app/fake app 的兜底。
  // 不能再 setTarget 新建 targetId，否则 verifier timeline 会和 copied transcript 断开。
  await context.deps.sessionStore.cloneTargetForFork({
    sessionID: forkedSessionId as SessionId,
    source: parentTarget,
    status: parentTarget.status,
  });
  forkRecord.stateRevision++;
  forkRecord.updatedAt = Date.now();
}

async function resolveForkTarget(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  target: ZCodeSessionHistoryTarget,
): Promise<{ targetCheckpointId?: string; targetMessageId?: string }> {
  if (target.kind === "latestCheckpoint") {
    return {};
  }
  if (target.kind === "checkpoint") {
    return { targetCheckpointId: target.checkpointId };
  }
  if (target.kind === "message") {
    return { targetMessageId: target.messageId };
  }
  return {
    targetMessageId: await resolveTurnMessageId(context, record, target.turnIndex, "assistant"),
  };
}

async function resolveTurnMessageId(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  turnIndex: number,
  role: "assistant" | "user",
): Promise<MessageId> {
  const messages = (await readActiveSessionMessages(context, record)).filter(
    isUserVisibleSessionMessage,
  );
  let currentTurn = -1;
  let lastAssistantForTargetTurn: MessageId | undefined;
  for (const message of messages) {
    if (message.info.role === "user") {
      if (role === "assistant" && currentTurn === turnIndex && lastAssistantForTargetTurn) {
        // fork/rewind 的 legacy turn target 是“目标轮次的 assistant”，
        // 不是“扫描到历史末尾时仍然处于目标轮次”。遇到下一条 user 就清空已找到的
        // assistant，导致只有最后一轮能 fork；compact summary 和 fork notice 这类 synthetic
        // user 又会把最后一轮变成非最后一轮。离开目标轮次前直接返回稳定目标。
        return lastAssistantForTargetTurn;
      }
      currentTurn += 1;
      if (role === "user" && currentTurn === turnIndex) {
        return message.info.id as MessageId;
      }
      continue;
    }
    if (message.info.role === "assistant" && currentTurn === turnIndex) {
      lastAssistantForTargetTurn = message.info.id as MessageId;
    }
  }
  if (role === "assistant" && lastAssistantForTargetTurn) {
    return lastAssistantForTargetTurn;
  }
  throw new ProtocolRequestError(
    zcodeProtocolErrorCodes.sessionUnavailable,
    `Cannot resolve ${role} message for turnIndex=${turnIndex}`,
  );
}
