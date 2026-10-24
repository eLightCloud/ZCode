import type { BackgroundTaskTrackerContext } from "./background-tracker-context.js";
import type { BackgroundTaskTrackerApi } from "./background-tracker-api.js";
import * as implementation1 from "./background-tracker-events.js";
import * as implementation2 from "./background-tracker-notifications.js";
import * as implementation0 from "./background-tracker-polling.js";
import * as implementation3 from "./background-tracker-provider.js";

import type { ToolExecutorDeps } from "./types.js";

// ⚠ 两个 artifact：上面那个是脚本的**顶层返回值**（引擎内部的 `RunSettlement.artifact`，进
// `<result>`），下面这个是脚本经 `artifact.*` **发布给用户看的产出**（进 `<artifacts>`）。
// 两者在同一条完成通知里并列出现，所以模块也分开。

export class BackgroundTaskTracker {
  private readonly backgroundPollers: BackgroundTaskTrackerContext["backgroundPollers"] =
    new Set<string>();

  constructor(private readonly deps: ToolExecutorDeps) {}

  declare private emitBackgroundTaskEvent: OmitThisParameter<
    typeof implementation1.emitBackgroundTaskEvent
  >;

  declare private backgroundTaskPayload: OmitThisParameter<
    typeof implementation1.backgroundTaskPayload
  >;

  declare private backgroundSnapshotSignature: OmitThisParameter<
    typeof implementation1.backgroundSnapshotSignature
  >;

  declare private canCancelBackgroundTask: OmitThisParameter<
    typeof implementation1.canCancelBackgroundTask
  >;

  declare private isNotifiedLocalAgentSnapshot: OmitThisParameter<
    typeof implementation1.isNotifiedLocalAgentSnapshot
  >;

  declare private maybeEnqueueBackgroundTaskNotification: OmitThisParameter<
    typeof implementation2.maybeEnqueueBackgroundTaskNotification
  >;

  declare private formatBackgroundTaskNotification: OmitThisParameter<
    typeof implementation2.formatBackgroundTaskNotification
  >;

  declare private formatWorkflowTaskNotification: OmitThisParameter<
    typeof implementation2.formatWorkflowTaskNotification
  >;

  declare private hasBackgroundTaskSnapshotProvider: OmitThisParameter<
    typeof implementation3.hasBackgroundTaskSnapshotProvider
  >;

  declare private hasDirectBackgroundTaskWaiter: OmitThisParameter<
    typeof implementation3.hasDirectBackgroundTaskWaiter
  >;

  declare private waitForBackgroundTaskSnapshot: OmitThisParameter<
    typeof implementation3.waitForBackgroundTaskSnapshot
  >;

  declare private getBackgroundTaskSnapshot: OmitThisParameter<
    typeof implementation3.getBackgroundTaskSnapshot
  >;

  /**
   * 按工具名解析后台生命周期提供者。每个分支只描述"这个工具的四件事分别由哪个端口承担"，
   * 与泛化前的五处 if 一一对应，语义逐字保持。
   */
  declare private lifecycleProvider: OmitThisParameter<typeof implementation3.lifecycleProvider>;
}

export interface BackgroundTaskTracker extends BackgroundTaskTrackerApi {}

// 与 owner 共享原型和 this；保持方法不可枚举，clone/继承沿原路径工作。
for (const methods of [implementation0, implementation1, implementation2, implementation3]) {
  for (const [name, value] of Object.entries(methods)) {
    Object.defineProperty(BackgroundTaskTracker.prototype, name, {
      value,
      writable: true,
      configurable: true,
    });
  }
}
