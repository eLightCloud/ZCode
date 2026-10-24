// 稳定的协议用例入口；各职责按原 session/context 协作，不承载第二状态或执行实现。
export {
  createSession,
  createSessionRecordForV4,
  type ActivatedSessionForResume,
  discardFailedSessionResume,
  activateSessionForResume,
  resumeSession,
  closeSession,
  shouldCloseSessionForExpectedPersistence,
} from "./protocol-session-lifecycle.js";
export {
  listSessions,
  listSessionSubagents,
  getUsageStats,
  readSession,
  readSessionContextUsage,
  readMessages,
  readEvents,
  subscribeSession,
  getTaskTokenUsage,
} from "./protocol-session-queries.js";
export {
  sendPrompt,
  compactSession,
  stopSession,
  cancelBackgroundTask,
} from "./protocol-session-input.js";
export { goalSession } from "./protocol-session-goal.js";
export { forkSession, registerForkedSession } from "./protocol-session-fork.js";
export {
  setModel,
  setThoughtLevel,
  setMode,
  ensureSessionModelAvailableForNextTurn,
} from "./protocol-session-model.js";
export { generateWorkspaceText } from "./protocol-workspace-text.js";
export { onSessionEvent } from "./protocol-event-live.js";
export { afterStateMutation } from "./protocol-state-notifications.js";
