import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  // 工作区在恢复后才出现；不能因此改变 React hook 调用顺序。
  const contextServices = useServices();
  const workspaceServices = useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity);
  const services = workspacePath ? workspaceServices : contextServices;
  return services.zcodeSessionService;
}
