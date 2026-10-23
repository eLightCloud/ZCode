// ============================================================
// Permission Service - Permission checking and decision making
// ============================================================

import { type PermissionRuleset } from "@zcode/contracts";

import { resolvePlanModeTransitionPermission } from "./plan-mode-policy.js";

import { isPreapprovedWorkflowDraftWrite } from "./workflow-draft-path.js";

import type { ToolPermissionRulePolicy } from "../tool/types.js";

import { WORKFLOW_DRAFT_PREAPPROVED_RULE_ID } from "./permission-service-contract.js";

import type { PermissionServiceContext } from "./permission-context.js";
import type {
  PermissionContext,
  PermissionDecisionResult,
  PermissionToolCapability,
} from "./permission-service-contract.js";
export function checkPermission(
  this: PermissionServiceContext,
  context: PermissionContext,
  toolCapability?: PermissionToolCapability,
  projectRules?: PermissionRuleset | null,
  rulePolicy?: ToolPermissionRulePolicy,
): PermissionDecisionResult {
  const capability = this.resolveCapability(context, toolCapability);
  const planModeTransition = resolvePlanModeTransitionPermission(context);

  if (planModeTransition) {
    return planModeTransition.behavior === "allow"
      ? this.allow(context, capability, planModeTransition.ruleId, planModeTransition.reason)
      : this.deny(context, capability, planModeTransition.ruleId, planModeTransition.reason);
  }

  if (capability.requiresUserInteraction) {
    if (this.config.disallowedTools.has(context.toolName)) {
      return this.deny(
        context,
        capability,
        "rule.disallowedTools",
        `Tool ${context.toolName} is explicitly disallowed`,
      );
    }

    return this.ask(
      context,
      capability,
      "tool.userInteraction",
      `Tool ${context.toolName} requires user interaction`,
    );
  }

  // 独立 Plan 优先于 Guarded 的 YOLO 基础策略，审批不能解除 Plan 的执行限制。
  const planEnabled = context.planEnabled ?? context.mode === "plan";
  if (!planEnabled && context.mode === "guarded" && toolCapability?.userApprovalRule) {
    return {
      ...this.ask(
        context,
        capability,
        toolCapability.userApprovalRule,
        "Dangerous command requires your approval for this execution",
      ),
      approvalMode: "user-once",
    };
  }

  // 保留 staging 的工具级确认，不被 Guarded 普通调用的 YOLO 基础策略跳过。
  if (capability.alwaysAsk) {
    return this.checkAlwaysAsk(context, capability, projectRules, rulePolicy);
  }

  if ((context.mode === "yolo" || context.mode === "guarded") && !planEnabled) {
    return this.allow(context, capability, "mode.yolo", "Yolo mode bypasses permission prompts");
  }

  if (context.mode === "auto") {
    return this.deny(
      context,
      capability,
      "mode.auto.unimplemented",
      "Auto mode is reserved but not implemented yet",
    );
  }

  if (this.config.disallowedTools.has(context.toolName)) {
    return this.deny(
      context,
      capability,
      "rule.disallowedTools",
      `Tool ${context.toolName} is explicitly disallowed`,
    );
  }

  if (this.matchesProjectRules(projectRules, "deny", context, capability, rulePolicy)) {
    return this.deny(
      context,
      capability,
      "rule.project.deny",
      `Tool ${context.toolName} is denied by project permission rules`,
    );
  }

  if (this.matchesProjectRules(projectRules, "ask", context, capability, rulePolicy)) {
    return this.ask(
      context,
      capability,
      "rule.project.ask",
      `Tool ${context.toolName} requires approval by project permission rules`,
    );
  }

  // 原会话回复的接收范围由 Host 再次校验；network 副作用不能让这个免审批契约重新弹窗。
  // 放在显式 deny/ask 之后，且同时匹配内置工具名和能力，不能扩大其他网络工具的权限。
  if (
    context.toolName === "ReplyToChannel" &&
    capability.permissionName === "channel.reply" &&
    capability.sideEffectScope === "network" &&
    capability.riskLevel === "medium" &&
    !capability.destructive &&
    !capability.needsApproval
  ) {
    return this.allow(
      context,
      capability,
      "tool.channelReply.preapproved",
      "The originating bot conversation is already authorized",
    );
  }

  if (planEnabled) {
    return this.checkPlanMode(context, capability);
  }

  if (this.matchesProjectRules(projectRules, "allow", context, capability, rulePolicy)) {
    return this.allow(
      context,
      capability,
      "rule.project.allow",
      `Tool ${context.toolName} is allowed by project permission rules`,
    );
  }

  if (this.isPreapprovedWebFetchRequest(context)) {
    return this.allow(
      context,
      capability,
      "tool.webfetch.preapproved",
      "WebFetch URL is preapproved",
    );
  }

  // workflow 草稿免确认：
  // 与 WebFetch 预批同一位次——排在 plan 分支之后，因为 plan 模式必须继续拦下一切写入，
  // 草稿也是写入；也排在项目 deny / ask 之后，项目规则照样压得过它。判定本身见
  // workflow-draft-path.ts（含"为什么这样放行是安全的"）。
  if (
    isPreapprovedWorkflowDraftWrite({
      input: context.input,
      toolName: context.toolName,
      workingDirectory: context.workingDirectory,
    })
  ) {
    return this.allow(
      context,
      capability,
      WORKFLOW_DRAFT_PREAPPROVED_RULE_ID,
      "Workflow draft file is preapproved",
    );
  }

  if (this.config.allowedTools.has(context.toolName)) {
    return this.allow(
      context,
      capability,
      "rule.allowedTools",
      `Tool ${context.toolName} is explicitly allowed`,
    );
  }

  if (context.mode === "edit") {
    return this.checkEditMode(context, capability);
  }

  return this.checkBuildMode(context, capability);
}
