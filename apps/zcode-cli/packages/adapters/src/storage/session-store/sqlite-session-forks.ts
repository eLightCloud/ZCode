import type {
  CreateSessionInput,
  ForkChildSessionMetadata,
  ForkCommitBundle,
  SessionInfo,
} from "@zcode/contracts";

// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。

import { cloneSessionTargetForFork } from "../session-target.js";

import * as messageRepository from "./repositories/messages.js";

import * as sessionEntryRepository from "./repositories/session-entries.js";

import * as sessionInputRepository from "./repositories/session-inputs.js";

import * as sessionRepository from "./repositories/sessions.js";

import { assertForkBundleChildLocal, forkChildSessionId } from "./fork-bundle-validation.js";
import type { SqliteSessionStoreContext } from "./sqlite-session-context.js";
export async function createForkedSessionWithMetadata(
  this: SqliteSessionStoreContext,
  input: CreateSessionInput,
  metadata: ForkChildSessionMetadata,
): Promise<SessionInfo> {
  this.throwBeforeWrite();
  if (!input.parentID || String(input.parentID) !== metadata.parentSessionId) {
    throw new Error("Fork child metadata parent does not match session parentID");
  }
  const orderedMessageIds = metadata.forkTarget.orderedMessageIds;
  // compact 覆盖首轮 query 时，input 前稳定前缀合法为空；boundaryMessageId 仍记录
  // 被编辑 input，供幂等事实定位，但不会被复制进 child。
  const validBoundary =
    metadata.forkTarget.boundaryMessageId.trim().length > 0 &&
    (orderedMessageIds.length === 0 ||
      orderedMessageIds.at(-1) === metadata.forkTarget.boundaryMessageId);
  if (!metadata.sourceCommandId.trim() || !validBoundary) {
    throw new Error("Fork child metadata is invalid");
  }

  // command key 是 (parentSessionId, sourceCommandId)；session_entry.id 是全库主键，
  // 必须把 parent 纳入 id，避免两个 session 恰好复用 commandId 时互相覆盖事实。
  const entryId = `v4_command_fact:child:${metadata.parentSessionId}:${metadata.sourceCommandId}`;
  this.db.exec("begin immediate");
  try {
    const existing = sessionEntryRepository
      .sessionEntries(this.db, {
        sessionID: input.parentID,
        type: "v4/command_fact",
      })
      .find((entry) => entry.id === entryId);
    if (existing) {
      const childSessionId = forkChildSessionId(existing);
      if (!childSessionId) {
        throw new Error(`Fork child command fact is corrupt: ${entryId}`);
      }
      const child = sessionRepository.getSession(this.db, childSessionId);
      if (!child) {
        throw new Error(`Fork child session is missing: ${childSessionId}`);
      }
      this.db.exec("commit");
      return child;
    }

    const child = sessionRepository.createSession(this.db, input);
    const now = Date.now();
    sessionEntryRepository.saveSessionEntry(this.db, {
      id: entryId,
      sessionID: input.parentID,
      type: "v4/command_fact",
      time: { created: now, updated: now },
      data: {
        source: "child",
        ack: {
          commandId: metadata.sourceCommandId,
          status: "accepted",
          revisionAtDecision: 0,
          result: { type: "forkAssistant", sessionId: String(child.id) },
        },
        metadata,
      },
    });
    this.db.exec("commit");
    return child;
  } catch (error) {
    this.db.exec("rollback");
    throw error;
  }
}

export async function commitForkBundle(
  this: SqliteSessionStoreContext,
  bundle: ForkCommitBundle,
): Promise<SessionInfo> {
  this.throwBeforeWrite();
  const { child, commandFact, initialInput } = bundle;
  if (
    !child.parentID ||
    String(child.parentID) !== commandFact.parentSessionId ||
    (initialInput && String(initialInput.sessionID) !== String(child.id)) ||
    commandFact.ack.commandId !== commandFact.sourceCommandId
  ) {
    throw new Error("Fork commit bundle identity is invalid");
  }
  const entryId = `v4_command_fact:child:${commandFact.parentSessionId}:${commandFact.sourceCommandId}`;
  this.db.exec("begin immediate");
  try {
    const existing = sessionEntryRepository
      .sessionEntries(this.db, {
        sessionID: child.parentID,
        type: "v4/command_fact",
      })
      .find((entry) => entry.id === entryId);
    if (existing) {
      const existingChildId = forkChildSessionId(existing);
      const existingChild = existingChildId
        ? sessionRepository.getSession(this.db, existingChildId)
        : null;
      if (!existingChild) throw new Error(`Fork bundle command fact is corrupt: ${entryId}`);
      this.db.exec("commit");
      return existingChild;
    }

    assertForkBundleChildLocal(bundle);
    const persistedChild = sessionRepository.createSession(this.db, child);
    this.maybeThrowForkCommitFault("afterChild");
    for (const message of bundle.messages) {
      const messageSource = bundle.copySources?.messages[message.info.id];
      await messageRepository.saveMessage(
        this.db,
        message.info,
        messageSource ? { sessionID: child.parentID, id: messageSource } : undefined,
      );
      for (const part of message.parts) {
        const partSource = bundle.copySources?.parts[part.id];
        await messageRepository.savePart(
          this.db,
          part,
          partSource ? { sessionID: child.parentID, id: partSource } : undefined,
        );
      }
    }
    this.maybeThrowForkCommitFault("afterMessages");
    if (bundle.goal) {
      cloneSessionTargetForFork(this.db, {
        source: bundle.goal.source,
        sessionID: child.id,
        status: bundle.goal.status,
      });
    }
    this.maybeThrowForkCommitFault("afterGoal");
    for (const entry of bundle.entries) {
      sessionEntryRepository.saveSessionEntry(this.db, entry);
    }
    this.maybeThrowForkCommitFault("afterEntries");
    if (initialInput) {
      await sessionInputRepository.saveSessionInput(this.db, initialInput);
    }
    this.maybeThrowForkCommitFault("afterInput");
    const now = Date.now();
    sessionEntryRepository.saveSessionEntry(this.db, {
      id: entryId,
      sessionID: child.parentID,
      type: "v4/command_fact",
      time: { created: now, updated: now },
      data: {
        source: "child",
        ack: commandFact.ack,
        metadata: commandFact.metadata,
      },
    });
    this.maybeThrowForkCommitFault("afterCommandFact");
    this.maybeThrowForkCommitFault("beforeCommit");
    this.db.exec("commit");
    return persistedChild;
  } catch (error) {
    this.db.exec("rollback");
    throw error;
  }
}
