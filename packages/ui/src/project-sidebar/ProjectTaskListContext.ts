import { createContext } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { useApplicationPeripherals } from "@/root/ApplicationPeripherals.js";

/** 有首页跳转回调时，行来自只读项目树；写操作要等用户进入工作区。 */
export function useProjectedTaskReadOnlyReason() {
  const { intl } = useZCodeIntl();
  const openEntryTask = useApplicationPeripherals()?.openEntryProjectTask;
  return openEntryTask ? intl.formatMessage({ id: "taskList.openWorkspaceToManage" }) : undefined;
}

/** 列表展示配置只来自侧栏 owner；不承载 Host 行集合或会话运行态。 */
export const ProjectTaskListContext = createContext<{
  isWebRemoteControl?: boolean;
  activeWorkspaceKey?: string;
  mobileActiveTaskKey?: string | null;
  onOpenTaskFiles?: (task: ProjectTask, remoteSessionId?: string) => Promise<void>;
  onPin?: (task: ProjectTask, pinned: boolean, commit: () => Promise<unknown>) => Promise<void>;
}>({});
