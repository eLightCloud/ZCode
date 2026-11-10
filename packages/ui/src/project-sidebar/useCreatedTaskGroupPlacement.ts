import { useCallback } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast, dismissToast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { groupTaskRef } from "@/project-sidebar/grouped-view.js";
import { readProjectSidebarTree } from "@/project-sidebar/project-tree-reader.js";
import { findCreatedProjectTask } from "@/project-sidebar/view.js";
import type { GroupTaskRef, ProjectTaskRef } from "@/project-sidebar/contract.js";

/** 创建意图只冻结 placement；任务 Host 由已确认目录提供，服务端仍复验真实 owner。 */
export function useCreatedTaskGroupPlacement() {
  const services = useBaseWorkspaceServices();
  const directory = useOptionalProjectDirectory();
  const refresh = directory?.groups.refresh;
  const { intl } = useZCodeIntl();
  return useCallback(
    (target: ProjectTaskRef, groupId: string | null | undefined, creationId: string) => {
      if (groupId === undefined) return undefined;
      const address = { ...target };
      let task: GroupTaskRef | undefined;
      let flight: Promise<void> | undefined;
      let notice: number | undefined;
      const organize = (confirmedTask?: GroupTaskRef): Promise<void> => {
        if (flight) return flight;
        if (confirmedTask) task = { ...confirmedTask };
        const attempt = async () => {
          try {
            if (!services.taskGroupService) throw new Error("task-group.service-unavailable");
            if (!task) {
              // 嵌入 pane 无目录 Provider 时，仍读取公开目录事实，不重建 local/remote 身份。
              const source = services.windowProjectDirectory ?? services;
              if (!source.projectService) throw new Error("project.service-unavailable");
              const { tree } = await readProjectSidebarTree({
                projectService: source.projectService,
                remoteProjectService: source.remoteProjectService,
              });
              const row = findCreatedProjectTask(tree, address);
              if (!row) throw new Error("task-group.created-task-unavailable");
              task = groupTaskRef(row);
            }
            await services.taskGroupService.admit({
              tasks: [task],
              placement: { task, groupId, creationId },
            });
            logger.info("[task-groups] 新任务归属提交完成", {
              taskId: address.taskId,
              hostId: task.hostId,
              creationId,
            });
            if (notice !== undefined) dismissToast(notice);
            // 辅助分组重读不进入首发屏障；完整 Shell 沿既有 owner 刷新。
            void refresh?.();
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "";
            const reason =
              [
                "task-group.host-identity-mismatch",
                "task-group.created-task-unavailable",
                "task-group.service-unavailable",
                "project.service-unavailable",
                "project.host-offline",
              ].find((code) => message.includes(code)) ?? "task-group.request-failed";
            logger.warn("[task-groups] 新任务归属提交失败", {
              taskId: address.taskId,
              hostId: task?.hostId,
              creationId,
              reason,
            });
            // 会话已经 accepted；重试只持有本次引用/placement，不调用创建或发送入口。
            notice = toast(intl.formatMessage({ id: "taskGroup.placementFailed" }), {
              variant: "warning",
              durationMs: 0,
              actionLabel: intl.formatMessage({ id: "taskGroup.retryPlacement" }),
              onAction: () => void organize(),
              dedupeKey: `task-group:${creationId}`,
            });
          }
        };
        flight = attempt().finally(() => {
          flight = undefined;
        });
        return flight;
      };
      return organize;
    },
    [services, refresh, intl],
  );
}
