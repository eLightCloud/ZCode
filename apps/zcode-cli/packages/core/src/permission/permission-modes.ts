// ============================================================
// Permission Service - Permission checking and decision making
// ============================================================

import {
  AMEND_WORKFLOW_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  isAmendWorkflowOwnedPredecessor,
  isFillWorkflowHoleOwnedRun,
  type PermissionRuleset,
} from "@zcode/contracts";

import type { ToolPermissionRulePolicy } from "../tool/types.js";

import type { PermissionServiceContext } from "./permission-context.js";
import type {
  PermissionContext,
  PermissionDecisionResult,
  ResolvedPermissionCapability,
} from "./permission-service-contract.js";
/**
 * 工具自报 alwaysAsk 时的判定：ask 压过所有"放行"分支（yolo 直通、plan 的 readOnly 直通），
 * 但**压不过"阻断"**——所以这里先自己走一遍硬阻断判定。
 *
 * 为什么不直接返回 ask：disallowedTools 是用户配置的硬禁用，项目 deny 规则符合工具自报的
 * denyPriority: "beforeAsk"，auto 模式是"该模式未实现"的保护。少了这一步，一个被硬禁用的
 * 工具会退化成"弹个窗、用户一点就能跑"。
 *
 * 这些判定在 checkPermission 里按原有顺序还会各自出现一次；此处刻意只覆盖 alwaysAsk 工具，
 * 不改动其他工具的既有优先级（尤其 yolo 目前先于 disallowedTools 放行这一点）。
 */

export function checkAlwaysAsk(
  this: PermissionServiceContext,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  projectRules?: PermissionRuleset | null,
  rulePolicy?: ToolPermissionRulePolicy,
): PermissionDecisionResult {
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
  // 会话免确认：阻断分支之后、ask 之前。命中即放行，不发 permission 事件、不弹窗；
  // 与 gate 本身一样不看模式（yolo / plan / build 一致）。
  if (this.matchesProjectRules(this.sessionRules, "allow", context, capability, rulePolicy)) {
    return this.allow(
      context,
      capability,
      "rule.session.allow",
      `Tool ${context.toolName} was allowed for this session`,
    );
  }
  // 修订免确认：AmendWorkflow 的前驱是
  // **本会话发起**的 run、且不是用户亲手停下的，即放行。与会话规则同位——阻断分支之后、ask 之前，
  // 不看模式。事实来自 resolveInput 回填的 `predecessor`（journal 的 parent_session_id / stopReason），
  // 不是内存表：重启、冷恢复后依然成立，也没有可播种、可撤销的东西。别的会话的 run、用户停过的
  // run 照常 ask：钥匙是 run 的归属，不是字段的在场。
  if (this.isOwnedWorkflowAmend(context)) {
    return this.allow(
      context,
      capability,
      "rule.session.workflowOwner",
      `Tool ${context.toolName} amends a run this session started`,
    );
  }
  return this.ask(
    context,
    capability,
    "tool.alwaysAsk",
    `Tool ${context.toolName} always requires explicit approval`,
  );
}

/**
 * AmendWorkflow 且回填的 `predecessor` 说「本会话的 run、非用户停下」；或 FillWorkflowHole 且回填的
 * `hole` 说同一件事（docs/dynamic-workflow/launch.md「Approval」：补全是对一个在飞 run 脚本的修订，
 * 由同一条 amend 规则判定）。
 */

export function isOwnedWorkflowAmend(
  this: PermissionServiceContext,
  context: PermissionContext,
): boolean {
  if (!context.input || typeof context.input !== "object") return false;
  const input = context.input as Record<string, unknown>;
  // 谓词本体住在契约里：就地调并发落回修订时读的必须是同一条规则，不能各写一遍。
  if (context.toolName === AMEND_WORKFLOW_TOOL_NAME) {
    return isAmendWorkflowOwnedPredecessor(input.predecessor);
  }
  if (context.toolName === FILL_WORKFLOW_HOLE_TOOL_NAME) {
    return isFillWorkflowHoleOwnedRun(input.hole);
  }
  return false;
}

export function checkPlanMode(
  this: PermissionServiceContext,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
): PermissionDecisionResult {
  if (capability.readOnly && !capability.destructive) {
    return this.allow(
      context,
      capability,
      "mode.plan.readOnly",
      "Plan mode allows read-only tool execution",
    );
  }

  if (this.isMcpToolCapability(capability) && !capability.destructive) {
    return this.allow(
      context,
      capability,
      "mode.plan.mcp",
      "Plan mode allows non-destructive MCP tool execution",
    );
  }

  if (
    capability.allowedInPlanMode &&
    capability.sideEffectScope === "session" &&
    !capability.destructive &&
    !capability.needsApproval
  ) {
    return this.allow(
      context,
      capability,
      "mode.plan.explicitSessionCapability",
      "Plan mode allows this explicit non-destructive session control action",
    );
  }

  return this.deny(
    context,
    capability,
    "mode.plan.nonReadOnly",
    "Plan mode only allows read-only, non-destructive tools",
  );
}

export function isMcpToolCapability(
  this: PermissionServiceContext,
  capability: ResolvedPermissionCapability,
): boolean {
  return capability.permissionName === "mcp";
}

export function checkBuildMode(
  this: PermissionServiceContext,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
): PermissionDecisionResult {
  if (capability.readOnly && !capability.destructive && !capability.needsApproval) {
    return this.allow(
      context,
      capability,
      "mode.build.readOnly",
      "Build mode allows read-only tools",
    );
  }

  if (capability.riskLevel === "critical") {
    return this.ask(
      context,
      capability,
      "mode.build.criticalRisk",
      "Critical risk tools require explicit approval",
    );
  }

  if (capability.riskLevel === "high" && !this.config.autoApproveHighRisk) {
    return this.ask(
      context,
      capability,
      "mode.build.highRisk",
      "High risk tools require explicit approval",
    );
  }

  if (
    capability.sideEffectScope === "session" &&
    capability.riskLevel === "low" &&
    !capability.destructive &&
    !capability.needsApproval
  ) {
    return this.allow(
      context,
      capability,
      "mode.build.sessionState",
      "Build mode allows low-risk session-local state updates",
    );
  }

  if (capability.needsApproval || capability.destructive || capability.sideEffectScope !== "none") {
    return this.ask(
      context,
      capability,
      "mode.build.sideEffect",
      "Tool has side effects and requires approval",
    );
  }

  return this.allow(
    context,
    capability,
    "mode.build.lowRisk",
    "Build mode allows low-risk tool execution",
  );
}

export function checkEditMode(
  this: PermissionServiceContext,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
): PermissionDecisionResult {
  if (capability.permissionName === "edit" && capability.sideEffectScope === "workspace") {
    return this.allow(
      context,
      capability,
      "mode.edit.fileEdit",
      "Edit mode allows file edit tools",
    );
  }

  return this.checkBuildMode(context, capability);
}
