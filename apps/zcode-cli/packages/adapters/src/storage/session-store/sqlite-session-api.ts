import type {
  AppUsageQueryResult,
  CollaborationMode,
  InputHistoryEntry,
  MessageWithParts,
  PermissionRuleset,
  ScriptWorkflowActivityRecord,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowEventRecord,
  ScriptWorkflowRunRecord,
  SessionEntryInfo,
  SessionGoal,
  SessionInfo,
  SessionInputRecord,
  SessionTaskLinkRecord,
  TaskUsageQueryResult,
  TodoItem,
} from "@zcode/contracts";

// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。
import type { JournalStorePort } from "@zcode/dynamic-workflow";

import type { SessionStoreDebugCounts } from "./options.js";

import * as implementation0 from "./sqlite-session-checkpoints.js";
import * as implementation10 from "./sqlite-session-diagnostics.js";
import * as continuation from "./sqlite-session-continuation.js";
import * as implementation1 from "./sqlite-session-forks.js";
import * as implementation5 from "./sqlite-session-inputs.js";
import * as implementation4 from "./sqlite-session-messages.js";
import * as implementation3 from "./sqlite-session-metadata.js";
import * as implementation8 from "./sqlite-session-permissions.js";
import * as implementation2 from "./sqlite-session-shared-context.js";
import * as implementation6 from "./sqlite-session-targets.js";
import * as implementation7 from "./sqlite-session-usage.js";
import * as implementation9 from "./sqlite-session-workflows.js";
export interface SqliteSessionStoreApi {
  softDeleteSession(
    ...args: Parameters<typeof implementation3.softDeleteSession>
  ): ReturnType<typeof implementation3.softDeleteSession>;
  controlContinuation(
    ...args: Parameters<typeof continuation.controlContinuation>
  ): ReturnType<typeof continuation.controlContinuation>;
  exportTextCheckpoint(
    ...args: Parameters<typeof implementation0.exportTextCheckpoint>
  ): ReturnType<typeof implementation0.exportTextCheckpoint>;
  importTextCheckpoint(
    ...args: Parameters<typeof implementation0.importTextCheckpoint>
  ): ReturnType<typeof implementation0.importTextCheckpoint>;
  createForkedSessionWithMetadata(
    ...args: Parameters<typeof implementation1.createForkedSessionWithMetadata>
  ): Promise<SessionInfo>;
  commitForkBundle(
    ...args: Parameters<typeof implementation1.commitForkBundle>
  ): Promise<SessionInfo>;
  commitSharedContextImportBundle(
    ...args: Parameters<typeof implementation2.commitSharedContextImportBundle>
  ): Promise<SessionInfo>;
  transitionSharedContextImport(
    ...args: Parameters<typeof implementation2.transitionSharedContextImport>
  ): Promise<boolean>;
  createSession(...args: Parameters<typeof implementation3.createSession>): Promise<SessionInfo>;
  updateSession(...args: Parameters<typeof implementation3.updateSession>): Promise<SessionInfo>;
  getSession(...args: Parameters<typeof implementation3.getSession>): Promise<SessionInfo | null>;
  listSessions(...args: Parameters<typeof implementation3.listSessions>): Promise<SessionInfo[]>;
  claimLegacySessionWorkspace(
    ...args: Parameters<typeof implementation3.claimLegacySessionWorkspace>
  ): Promise<number>;
  repairLegacyRemoteSessionWorkspace(
    ...args: Parameters<typeof implementation3.repairLegacyRemoteSessionWorkspace>
  ): Promise<boolean>;
  repairRemoteSessionPaths(
    ...args: Parameters<typeof implementation3.repairRemoteSessionPaths>
  ): Promise<boolean>;
  setRevert(...args: Parameters<typeof implementation3.setRevert>): Promise<void>;
  clearRevert(...args: Parameters<typeof implementation3.clearRevert>): Promise<void>;
  saveMessage(...args: Parameters<typeof implementation4.saveMessage>): Promise<void>;
  removeMessage(...args: Parameters<typeof implementation4.removeMessage>): Promise<void>;
  savePart(...args: Parameters<typeof implementation4.savePart>): Promise<void>;
  removePart(...args: Parameters<typeof implementation4.removePart>): Promise<void>;
  messageWithParts(
    ...args: Parameters<typeof implementation4.messageWithParts>
  ): Promise<MessageWithParts | null>;
  messages(...args: Parameters<typeof implementation4.messages>): Promise<MessageWithParts[]>;
  saveSessionEntry(...args: Parameters<typeof implementation4.saveSessionEntry>): Promise<void>;
  sessionEntries(
    ...args: Parameters<typeof implementation4.sessionEntries>
  ): Promise<SessionEntryInfo[]>;
  saveSessionInput(...args: Parameters<typeof implementation5.saveSessionInput>): Promise<void>;
  updateSessionInputs(
    ...args: Parameters<typeof implementation5.updateSessionInputs>
  ): Promise<void>;
  promoteSessionInput(
    ...args: Parameters<typeof implementation5.promoteSessionInput>
  ): Promise<void>;
  markSessionInputPromoted(
    ...args: Parameters<typeof implementation5.markSessionInputPromoted>
  ): Promise<void>;
  settleSessionInput(...args: Parameters<typeof implementation5.settleSessionInput>): Promise<void>;
  listSessionInputs(
    ...args: Parameters<typeof implementation5.listSessionInputs>
  ): Promise<SessionInputRecord[]>;
  getSessionInputById(
    ...args: Parameters<typeof implementation5.getSessionInputById>
  ): Promise<SessionInputRecord | null>;
  recordInputHistory(
    ...args: Parameters<typeof implementation5.recordInputHistory>
  ): Promise<InputHistoryEntry | null>;
  recallPreviousInputHistory(
    ...args: Parameters<typeof implementation5.recallPreviousInputHistory>
  ): Promise<InputHistoryEntry | null>;
  readTodos(...args: Parameters<typeof implementation6.readTodos>): Promise<TodoItem[]>;
  updateTodos(...args: Parameters<typeof implementation6.updateTodos>): Promise<void>;
  readTarget(...args: Parameters<typeof implementation6.readTarget>): Promise<SessionGoal | null>;
  setTarget(...args: Parameters<typeof implementation6.setTarget>): Promise<SessionGoal>;
  cloneTargetForFork(
    ...args: Parameters<typeof implementation6.cloneTargetForFork>
  ): Promise<SessionGoal>;
  createTarget(
    ...args: Parameters<typeof implementation6.createTarget>
  ): Promise<SessionGoal | null>;
  updateTargetStatus(
    ...args: Parameters<typeof implementation6.updateTargetStatus>
  ): Promise<SessionGoal | null>;
  startTargetRun(
    ...args: Parameters<typeof implementation6.startTargetRun>
  ): Promise<SessionGoal | null>;
  heartbeatTargetRun(
    ...args: Parameters<typeof implementation6.heartbeatTargetRun>
  ): Promise<SessionGoal | null>;
  finishTargetRun(
    ...args: Parameters<typeof implementation6.finishTargetRun>
  ): Promise<SessionGoal | null>;
  recoverInterruptedTargetRun(
    ...args: Parameters<typeof implementation6.recoverInterruptedTargetRun>
  ): Promise<SessionGoal | null>;
  accountTargetUsage(
    ...args: Parameters<typeof implementation6.accountTargetUsage>
  ): Promise<SessionGoal | null>;
  updateTargetSummaryTitle(
    ...args: Parameters<typeof implementation6.updateTargetSummaryTitle>
  ): Promise<SessionGoal | null>;
  clearTarget(...args: Parameters<typeof implementation6.clearTarget>): Promise<boolean>;
  recordModelUsage(...args: Parameters<typeof implementation7.recordModelUsage>): Promise<void>;
  upsertTurnUsage(...args: Parameters<typeof implementation7.upsertTurnUsage>): Promise<void>;
  upsertToolUsage(...args: Parameters<typeof implementation7.upsertToolUsage>): Promise<void>;
  pruneUsage(...args: Parameters<typeof implementation7.pruneUsage>): Promise<void>;
  queryAppUsage(
    ...args: Parameters<typeof implementation7.queryAppUsage>
  ): Promise<AppUsageQueryResult>;
  queryTaskUsage(
    ...args: Parameters<typeof implementation7.queryTaskUsage>
  ): Promise<TaskUsageQueryResult>;
  commitPermissionFullAccess(
    ...args: Parameters<typeof implementation8.commitPermissionFullAccess>
  ): Promise<void>;
  getProjectPermission(
    ...args: Parameters<typeof implementation8.getProjectPermission>
  ): Promise<PermissionRuleset | null>;
  saveProjectPermission(
    ...args: Parameters<typeof implementation8.saveProjectPermission>
  ): Promise<PermissionRuleset>;
  getProjectPermissionMode(
    ...args: Parameters<typeof implementation8.getProjectPermissionMode>
  ): CollaborationMode | null;
  saveProjectPermissionMode(
    ...args: Parameters<typeof implementation8.saveProjectPermissionMode>
  ): CollaborationMode;
  upsertScriptWorkflowDefinition(
    ...args: Parameters<typeof implementation9.upsertScriptWorkflowDefinition>
  ): Promise<ScriptWorkflowDefinitionRecord>;
  createScriptWorkflowRun(
    ...args: Parameters<typeof implementation9.createScriptWorkflowRun>
  ): Promise<ScriptWorkflowRunRecord>;
  updateScriptWorkflowRun(
    ...args: Parameters<typeof implementation9.updateScriptWorkflowRun>
  ): Promise<ScriptWorkflowRunRecord>;
  getScriptWorkflowRun(
    ...args: Parameters<typeof implementation9.getScriptWorkflowRun>
  ): Promise<ScriptWorkflowRunRecord | null>;
  listScriptWorkflowRuns(
    ...args: Parameters<typeof implementation9.listScriptWorkflowRuns>
  ): Promise<ScriptWorkflowRunRecord[]>;
  createScriptWorkflowActivity(
    ...args: Parameters<typeof implementation9.createScriptWorkflowActivity>
  ): Promise<ScriptWorkflowActivityRecord>;
  updateScriptWorkflowActivity(
    ...args: Parameters<typeof implementation9.updateScriptWorkflowActivity>
  ): Promise<ScriptWorkflowActivityRecord>;
  findCachedScriptWorkflowActivity(
    ...args: Parameters<typeof implementation9.findCachedScriptWorkflowActivity>
  ): Promise<ScriptWorkflowActivityRecord | null>;
  listScriptWorkflowActivities(
    ...args: Parameters<typeof implementation9.listScriptWorkflowActivities>
  ): Promise<ScriptWorkflowActivityRecord[]>;
  appendScriptWorkflowEvent(
    ...args: Parameters<typeof implementation9.appendScriptWorkflowEvent>
  ): Promise<ScriptWorkflowEventRecord>;
  listScriptWorkflowEvents(
    ...args: Parameters<typeof implementation9.listScriptWorkflowEvents>
  ): Promise<ScriptWorkflowEventRecord[]>;
  createSessionTaskLink(
    ...args: Parameters<typeof implementation9.createSessionTaskLink>
  ): Promise<SessionTaskLinkRecord>;
  workflowJournalStore(
    ...args: Parameters<typeof implementation9.workflowJournalStore>
  ): JournalStorePort;
  debugMigrationIds(...args: Parameters<typeof implementation10.debugMigrationIds>): string[];
  debugCounts(...args: Parameters<typeof implementation10.debugCounts>): SessionStoreDebugCounts;
}
