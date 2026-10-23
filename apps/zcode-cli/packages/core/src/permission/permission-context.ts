import type { PermissionService } from "./service.js";

/** 同一 owner 的内部类型视图；不复制状态，不暴露到端口。 */
export interface PermissionServiceContext {
  sessionRules: PermissionService["sessionRules"];
  grantSessionPermission: PermissionService["grantSessionPermission"];
  checkPermission: PermissionService["checkPermission"];
  matchesProjectRules: PermissionService["matchesProjectRules"];
  matchesRule: PermissionService["matchesRule"];
  matchesRuleToolName: PermissionService["matchesRuleToolName"];
  matchesRuleScope: PermissionService["matchesRuleScope"];
  ruleSubjects: PermissionService["ruleSubjects"];
  isPreapprovedWebFetchRequest: PermissionService["isPreapprovedWebFetchRequest"];
  matchesRuleContent: PermissionService["matchesRuleContent"];
  checkAlwaysAsk: PermissionService["checkAlwaysAsk"];
  isOwnedWorkflowAmend: PermissionService["isOwnedWorkflowAmend"];
  checkPlanMode: PermissionService["checkPlanMode"];
  isMcpToolCapability: PermissionService["isMcpToolCapability"];
  checkBuildMode: PermissionService["checkBuildMode"];
  checkEditMode: PermissionService["checkEditMode"];
  requiresApproval: PermissionService["requiresApproval"];
  getRiskLevel: PermissionService["getRiskLevel"];
  isReadOnlyTool: PermissionService["isReadOnlyTool"];
  isWriteTool: PermissionService["isWriteTool"];
  isDestructiveTool: PermissionService["isDestructiveTool"];
  resolveCapability: PermissionService["resolveCapability"];
  allow: PermissionService["allow"];
  ask: PermissionService["ask"];
  deny: PermissionService["deny"];
  result: PermissionService["result"];
  config: PermissionService["config"];
}
