// ⚠ 两个 artifact：上面那个是脚本的**顶层返回值**（引擎内部的 `RunSettlement.artifact`，进
// `<result>`），下面这个是脚本经 `artifact.*` **发布给用户看的产出**（进 `<artifacts>`）。
// 两者在同一条完成通知里并列出现，所以模块也分开。

import * as implementation0 from "./background-tracker-polling.js";
export interface BackgroundTaskTrackerApi {
  trackBackgroundTask(
    ...args: Parameters<typeof implementation0.trackBackgroundTask>
  ): Promise<void>;
}
