import type { BackgroundTaskTracker } from "./background-tasks.js";

/** 同一 owner 的内部类型视图；不复制状态，不暴露到端口。 */
export interface BackgroundTaskTrackerContext {
  readonly backgroundPollers: BackgroundTaskTracker["backgroundPollers"];
  trackBackgroundTask: BackgroundTaskTracker["trackBackgroundTask"];
  emitBackgroundTaskEvent: BackgroundTaskTracker["emitBackgroundTaskEvent"];
  backgroundTaskPayload: BackgroundTaskTracker["backgroundTaskPayload"];
  backgroundSnapshotSignature: BackgroundTaskTracker["backgroundSnapshotSignature"];
  canCancelBackgroundTask: BackgroundTaskTracker["canCancelBackgroundTask"];
  isNotifiedLocalAgentSnapshot: BackgroundTaskTracker["isNotifiedLocalAgentSnapshot"];
  maybeEnqueueBackgroundTaskNotification: BackgroundTaskTracker["maybeEnqueueBackgroundTaskNotification"];
  formatBackgroundTaskNotification: BackgroundTaskTracker["formatBackgroundTaskNotification"];
  formatWorkflowTaskNotification: BackgroundTaskTracker["formatWorkflowTaskNotification"];
  hasBackgroundTaskSnapshotProvider: BackgroundTaskTracker["hasBackgroundTaskSnapshotProvider"];
  hasDirectBackgroundTaskWaiter: BackgroundTaskTracker["hasDirectBackgroundTaskWaiter"];
  waitForBackgroundTaskSnapshot: BackgroundTaskTracker["waitForBackgroundTaskSnapshot"];
  getBackgroundTaskSnapshot: BackgroundTaskTracker["getBackgroundTaskSnapshot"];
  lifecycleProvider: BackgroundTaskTracker["lifecycleProvider"];
  readonly deps: BackgroundTaskTracker["deps"];
}
