import type {
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  PartId,
  SessionEntryInfo,
  SessionEntryType,
  SessionId,
  SessionStorePort,
} from "@zcode/contracts";

// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。

import * as messageRepository from "./repositories/messages.js";

import * as sessionEntryRepository from "./repositories/session-entries.js";

import type { SqliteSessionStoreContext } from "./sqlite-session-context.js";
export async function saveMessage(
  this: SqliteSessionStoreContext,
  input: MessageInfo,
  copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
): Promise<void> {
  this.throwBeforeWrite();
  return messageRepository.saveMessage(this.db, input, copyFrom);
}

export async function removeMessage(
  this: SqliteSessionStoreContext,
  input: { sessionID: SessionId; messageID: MessageId },
): Promise<void> {
  this.throwBeforeWrite();
  return messageRepository.removeMessage(this.db, input);
}

export async function savePart(
  this: SqliteSessionStoreContext,
  input: MessagePart,
  copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
): Promise<void> {
  this.throwBeforeWrite();
  return messageRepository.savePart(this.db, input, copyFrom);
}

export async function removePart(
  this: SqliteSessionStoreContext,
  input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  },
): Promise<void> {
  this.throwBeforeWrite();
  return messageRepository.removePart(this.db, input);
}

export async function messageWithParts(
  this: SqliteSessionStoreContext,
  input: {
    sessionID: SessionId;
    messageID: MessageId;
  },
): Promise<MessageWithParts | null> {
  return messageRepository.messageWithParts(this.db, input);
}

export async function messages(
  this: SqliteSessionStoreContext,
  input: { sessionID: SessionId },
): Promise<MessageWithParts[]> {
  return messageRepository.messages(this.db, input);
}

export async function saveSessionEntry(
  this: SqliteSessionStoreContext,
  input: SessionEntryInfo,
): Promise<void> {
  this.throwBeforeWrite();
  return sessionEntryRepository.saveSessionEntry(this.db, input);
}

export async function sessionEntries(
  this: SqliteSessionStoreContext,
  input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  },
): Promise<SessionEntryInfo[]> {
  return sessionEntryRepository.sessionEntries(this.db, input);
}
