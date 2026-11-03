import { useEffect, useMemo, useState } from "react";
import type { VirtualProject } from "@zcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export interface AutomationProjectOption {
  projectId: string;
  hostId: string;
  workspacePath: string;
  label: string;
}

type ProjectScope = "local-only" | "current-host";

export function isRemoteAutomationWorkspace(tab: WorkspaceTabState | undefined): boolean {
  return Boolean(tab?.remoteSessionId || tab?.remoteTarget || tab?.workspaceIdentity);
}

export function resolveAutomationProjectOptions(
  projects: readonly VirtualProject[],
  scope: ProjectScope = "local-only",
): AutomationProjectOption[] {
  return projects
    .filter((project) => !project.deleted && (scope === "current-host" || project.hostId === "local"))
    .map((project) => ({
      projectId: project.id,
      hostId: project.hostId,
      workspacePath: project.roots.find((root) => root.isPrimary)?.rootPath ?? "",
      label: project.name,
    }));
}

/** 定义选择 Host 的虚拟项目；空项目在提交时初始化目录，不随打开的 tab 增减。 */
export function useAutomationProjectOptions(scope: ProjectScope = "local-only"): AutomationProjectOption[] {
  const services = useBaseWorkspaceServices();
  const [snapshot, setSnapshot] = useState<{ owner: typeof services; projects: VirtualProject[] }>();
  useEffect(() => {
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        if (!services.projectService) throw new Error("project.service-unavailable");
        const projects = await services.projectService.readProjects();
        // 不传 hostId 只读取此连接自己的项目。直连 Server 的项目带服务端标识，也属于这个 Host。
        if (request === generation) setSnapshot({ owner: services, projects });
      } catch (error) {
        if (request !== generation) return;
        setSnapshot(undefined);
        logger.error("[automation-projects] 读取项目选项失败", error);
      }
    };
    void refresh();
    const subscription = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") void refresh();
    });
    return () => {
      generation++;
      subscription.dispose();
    };
  }, [services]);
  return useMemo(
    () => resolveAutomationProjectOptions(snapshot?.owner === services ? snapshot.projects : [], scope),
    [snapshot, services, scope],
  );
}
