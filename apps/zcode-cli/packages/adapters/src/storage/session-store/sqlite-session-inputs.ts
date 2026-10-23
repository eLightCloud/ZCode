import type {
  InputHistoryAttachment,
  InputHistoryEntry,
  InputHistoryKind,
  MessageId,
  MessageInfo,
  MessagePart,
  ProjectId,
  SessionId,
  SessionInputDelivery,
  SessionInputRecord,
  SessionInputStatus,
  SessionStorePort,
} from "@zcode/contracts";

// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。

import * as inputHistoryRepository from "./repositories/input-history.js";

import * as sessionInputRepository from "./repositories/session-inputs.js";

import type { SqliteSessionStoreContext } from "./sqlite-session-context.js";
// ── session_input 账本──

export async function saveSessionInput(
  this: SqliteSessionStoreContext,
  input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  },
): Promise<void> {
  this.throwBeforeWrite();
  return sessionInputRepository.saveSessionInput(this.db, input);
}

export async function updateSessionInputs(
  this: SqliteSessionStoreContext,
  input: Parameters<NonNullable<SessionStorePort["updateSessionInputs"]>>[0],
): Promise<void> {
  this.throwBeforeWrite();
  return sessionInputRepository.updateSessionInputs(this.db, input);
}

export async function promoteSessionInput(
  this: SqliteSessionStoreContext,
  input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  },
): Promise<void> {
  this.throwBeforeWrite();
  return sessionInputRepository.promoteSessionInput(this.db, input);
}

export async function markSessionInputPromoted(
  this: SqliteSessionStoreContext,
  input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  },
): Promise<void> {
  this.throwBeforeWrite();
  return sessionInputRepository.markSessionInputPromoted(this.db, input);
}

export async function settleSessionInput(
  this: SqliteSessionStoreContext,
  input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  },
): Promise<void> {
  this.throwBeforeWrite();
  return sessionInputRepository.settleSessionInput(this.db, input);
}

export async function listSessionInputs(
  this: SqliteSessionStoreContext,
  input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  },
): Promise<SessionInputRecord[]> {
  return sessionInputRepository.listSessionInputs(this.db, input);
}

export async function getSessionInputById(
  this: SqliteSessionStoreContext,
  id: string,
): Promise<SessionInputRecord | null> {
  return sessionInputRepository.getSessionInputById(this.db, id);
}

export async function recordInputHistory(
  this: SqliteSessionStoreContext,
  input: {
    projectID: ProjectId;
    sessionID?: SessionId;
    text: string;
    attachments?: InputHistoryAttachment[];
    kind: InputHistoryKind;
    time?: { created?: number };
  },
): Promise<InputHistoryEntry | null> {
  return inputHistoryRepository.recordInputHistory(this.db, input);
}

export async function recallPreviousInputHistory(
  this: SqliteSessionStoreContext,
  input: {
    projectID: ProjectId;
    skip?: number;
  },
): Promise<InputHistoryEntry | null> {
  return inputHistoryRepository.recallPreviousInputHistory(this.db, input);
}
