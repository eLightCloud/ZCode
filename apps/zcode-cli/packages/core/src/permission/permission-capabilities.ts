// ============================================================
// Permission Service - Permission checking and decision making
// ============================================================

import { type RiskLevel } from "@zcode/contracts";

import type { PermissionServiceContext } from "./permission-context.js";
import type {
  PermissionBehavior,
  PermissionContext,
  PermissionDecisionResult,
  PermissionToolCapability,
  ResolvedPermissionCapability,
} from "./permission-service-contract.js";
export function requiresApproval(
  this: PermissionServiceContext,
  context: PermissionContext,
  toolCapability?: PermissionToolCapability,
): boolean {
  const decision = this.checkPermission(context, toolCapability);
  return decision.decision === "ask";
}

export function getRiskLevel(
  this: PermissionServiceContext,
  toolName: string,
  toolCapability?: PermissionToolCapability,
): RiskLevel {
  if (toolCapability?.riskLevel) {
    return toolCapability.riskLevel;
  }

  if (this.isReadOnlyTool(toolName)) {
    return "low";
  }

  if (this.isWriteTool(toolName)) {
    return "medium";
  }

  if (this.isDestructiveTool(toolName)) {
    return "high";
  }

  return "medium";
}

export function isReadOnlyTool(this: PermissionServiceContext, name: string): boolean {
  return new Set([
    "Read",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "TodoRead",
    "TodoWrite",
    "AskUserQuestion",
    "Agent",
    "Task",
    "Skill",
  ]).has(name);
}

export function isWriteTool(this: PermissionServiceContext, name: string): boolean {
  return new Set(["Write", "Edit", "ApplyPatch", "Bash"]).has(name);
}

export function isDestructiveTool(this: PermissionServiceContext, name: string): boolean {
  return new Set(["Bash"]).has(name);
}

export function resolveCapability(
  this: PermissionServiceContext,
  context: PermissionContext,
  toolCapability?: PermissionToolCapability,
): ResolvedPermissionCapability {
  return {
    allowedInPlanMode: toolCapability?.allowedInPlanMode ?? false,
    alwaysAsk: toolCapability?.permission?.alwaysAsk ?? toolCapability?.alwaysAsk ?? false,
    readOnly: toolCapability?.readOnly ?? this.isReadOnlyTool(context.toolName),
    destructive: toolCapability?.destructive ?? this.isDestructiveTool(context.toolName),
    requiresUserInteraction:
      toolCapability?.requiresUserInteraction ??
      (toolCapability?.permission?.sideEffectScope ?? toolCapability?.sideEffectScope) ===
        "userInteraction",
    sideEffectScope:
      toolCapability?.permission?.sideEffectScope ??
      toolCapability?.sideEffectScope ??
      (this.isReadOnlyTool(context.toolName) ? "none" : "workspace"),
    riskLevel:
      toolCapability?.permission?.riskLevel ?? this.getRiskLevel(context.toolName, toolCapability),
    needsApproval:
      toolCapability?.permission?.needsApproval ??
      toolCapability?.needsApproval ??
      !this.isReadOnlyTool(context.toolName),
    permissionCapabilityGroup: toolCapability?.permissionCapabilityGroup,
    permissionName: toolCapability?.permission?.permission,
  };
}

export function allow(
  this: PermissionServiceContext,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  ruleId: string,
  reason?: string,
): PermissionDecisionResult {
  return this.result("allow", context, capability, ruleId, reason);
}

export function ask(
  this: PermissionServiceContext,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  ruleId: string,
  reason: string,
): PermissionDecisionResult {
  return this.result("ask", context, capability, ruleId, reason);
}

export function deny(
  this: PermissionServiceContext,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  ruleId: string,
  reason: string,
): PermissionDecisionResult {
  return this.result("deny", context, capability, ruleId, reason);
}

export function result(
  this: PermissionServiceContext,
  decision: PermissionBehavior,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  ruleId: string,
  reason?: string,
): PermissionDecisionResult {
  return {
    decision,
    allowed: decision === "allow",
    escalated: decision === "ask",
    mode: context.mode,
    reason,
    riskLevel: capability.riskLevel,
    ruleId,
    sideEffectScope: capability.sideEffectScope,
    ...(capability.alwaysAsk ? { alwaysAsk: true } : {}),
  };
}
