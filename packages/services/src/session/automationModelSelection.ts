import type { ModelSelection, TraceId } from "@zcode/shared";
import { applicationModelAutomationAllowed } from "@zcode/provider";
import type { IModelSelectionService } from "../model-provider/providerFacadeServices.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { AutomationDispatchConfigurationError } from "./automationDispatchFailure.js";

/** 在 Automation Select 转为一次 Submission 的边界固定模型身份。 */
export async function resolveAutomationSubmissionModelSelection(params: {
  selection?: ModelSelection;
  diagnostic?: { runId: string; automationId: string };
  fixedSelection?: ModelSelection;
  readSelection?: () => Promise<ModelSelection | undefined>;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
}): Promise<ModelSelection> {
  // 已固定 run 是执行事实；重试不能重新对应账号，更不能被当前读取失败改变。
  const admitted = (selection: ModelSelection) => {
    assertAutomationApplicationModelAccess(selection, params.diagnostic);
    return selection;
  };
  if (params.fixedSelection) return admitted(params.fixedSelection);
  // Repo 在读取前完成离线导入；这里不绕行 Agent / 账号服务。
  // Scheduler 的快照可能早于 Host 单向导入；首次执行用持久层校验后的新版意图。
  const selection = params.readSelection ? await params.readSelection() : params.selection;
  if (selection) {
    const view = await params.modelSelectionService.getView({ selection });
    if (view.selectionIssue || !view.effectiveSelection?.options?.reasoningLevel) {
      throw new AutomationDispatchConfigurationError("model_selection_unavailable");
    }
    return admitted(view.effectiveSelection);
  }

  const preferredSelection = (await params.modelSelectionService.getView()).preferredSelection;
  if (
    applicationModelAutomationAllowed(process.env) &&
    preferredSelection?.providerId.startsWith("application:")
  ) {
    // 旧未绑定规则不能在首次执行时接管当前人的应用账号。
    throw new AutomationDispatchConfigurationError("model_selection_unavailable");
  }
  if (!preferredSelection?.options?.reasoningLevel) {
    throw new AutomationDispatchConfigurationError("model_selection_unavailable");
  }
  return admitted(preferredSelection);
}

/** Background use requires the trusted application's explicit user-transport capability. */
export function assertAutomationApplicationModelAccess(
  selection: ModelSelection,
  diagnostic?: { runId: string; automationId: string },
): void {
  if (
    applicationModelAutomationAllowed(process.env) ||
    !process.env["ZCODE_APPLICATION_MODEL_TOKEN"] ||
    !process.env["ZCODE_APPLICATION_MODEL_BASE_URL"] ||
    !selection.providerId.startsWith("application:")
  )
    return;
  createServiceLogger("automation-model-selection").info(diagnostic?.runId as TraceId | undefined, {
    event: "automation.admission",
    outcome: "blocked",
    reason: "application_automation_credentials_unavailable",
    runId: diagnostic?.runId,
    automationId: diagnostic?.automationId,
  });
  throw new AutomationDispatchConfigurationError("model_selection_unavailable");
}
