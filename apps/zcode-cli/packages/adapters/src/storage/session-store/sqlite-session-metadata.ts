import type {
  ClaimLegacySessionWorkspaceInput,
  CreateSessionInput,
  FileDiff,
  ListSessionsInput,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
  SessionId,
  SessionInfo,
  SessionRevert,
  UpdateSessionInput,
} from "@zcode/contracts";

// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。

import * as sessionRepository from "./repositories/sessions.js";

import type { SqliteSessionStoreContext } from "./sqlite-session-context.js";
export async function createSession(
  this: SqliteSessionStoreContext,
  input: CreateSessionInput,
): Promise<SessionInfo> {
  this.throwBeforeWrite();
  return sessionRepository.createSession(this.db, input);
}

export async function updateSession(
  this: SqliteSessionStoreContext,
  input: UpdateSessionInput,
): Promise<SessionInfo> {
  this.throwBeforeWrite();
  return sessionRepository.updateSession(this.db, input);
}

export async function getSession(
  this: SqliteSessionStoreContext,
  sessionID: SessionId,
): Promise<SessionInfo | null> {
  return sessionRepository.getSession(this.db, sessionID);
}

export async function listSessions(
  this: SqliteSessionStoreContext,
  input: ListSessionsInput = {},
): Promise<SessionInfo[]> {
  return sessionRepository.listSessions(this.db, input);
}

export async function claimLegacySessionWorkspace(
  this: SqliteSessionStoreContext,
  input: ClaimLegacySessionWorkspaceInput,
): Promise<number> {
  this.throwBeforeWrite();
  return sessionRepository.claimLegacySessionWorkspace(this.db, input);
}

export async function repairLegacyRemoteSessionWorkspace(
  this: SqliteSessionStoreContext,
  input: RepairLegacyRemoteSessionWorkspaceInput,
): Promise<boolean> {
  this.throwBeforeWrite();
  return sessionRepository.repairLegacyRemoteSessionWorkspace(this.db, input);
}

export async function repairRemoteSessionPaths(
  this: SqliteSessionStoreContext,
  input: RepairRemoteSessionPathsInput,
): Promise<boolean> {
  this.throwBeforeWrite();
  return sessionRepository.repairRemoteSessionPaths(this.db, input);
}

export async function setRevert(
  this: SqliteSessionStoreContext,
  input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  },
): Promise<void> {
  return sessionRepository.setRevert(this.db, input);
}

export async function clearRevert(
  this: SqliteSessionStoreContext,
  sessionID: SessionId,
): Promise<void> {
  return sessionRepository.clearRevert(this.db, sessionID);
}
