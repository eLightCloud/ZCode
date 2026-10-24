import type { PermissionRuleset } from "@zcode/contracts";
import type { PermissionUpdate } from "@zcode/contracts";
import type { PermissionConfig } from "./permission-service-contract.js";
import type { RiskLevel } from "@zcode/contracts";
import type { PermissionDecisionResult } from "./permission-service-contract.js";
import type { PermissionBehavior } from "./permission-service-contract.js";
import type { PermissionContext } from "./permission-service-contract.js";
import type { PermissionToolCapability } from "./permission-service-contract.js";
import type { ResolvedPermissionCapability } from "./permission-service-contract.js";
import type { ToolPermissionRulePolicy } from "../tool/types.js";
import type { PermissionRuleValue } from "@zcode/contracts";

/** 同一 owner 的唯一内部状态 / 协作形状；不从实现类反向取型。 */
export interface PermissionServiceContext {
  allow(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason?: string,
  ): PermissionDecisionResult;
  ask(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason: string,
  ): PermissionDecisionResult;
  checkAlwaysAsk(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult;
  checkBuildMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult;
  checkEditMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult;
  checkPermission(
    context: PermissionContext,
    toolCapability?: PermissionToolCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult;
  checkPlanMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult;
  config: PermissionConfig;
  deny(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason: string,
  ): PermissionDecisionResult;
  getRiskLevel(toolName: string, toolCapability?: PermissionToolCapability): RiskLevel;
  grantSessionPermission(updates: PermissionUpdate[]): void;
  isDestructiveTool(name: string): boolean;
  isMcpToolCapability(capability: ResolvedPermissionCapability): boolean;
  isOwnedWorkflowAmend(context: PermissionContext): boolean;
  isPreapprovedWebFetchRequest(context: PermissionContext): boolean;
  isReadOnlyTool(name: string): boolean;
  isWriteTool(name: string): boolean;
  matchesProjectRules(
    ruleset: PermissionRuleset | null | undefined,
    behavior: PermissionBehavior,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    rulePolicy?: ToolPermissionRulePolicy,
  ): boolean;
  matchesRule(
    rule: PermissionRuleValue,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): boolean;
  matchesRuleContent(subject: string, ruleContent: string): boolean;
  matchesRuleScope(
    rule: PermissionRuleValue,
    contextToolName: string,
    capability: ResolvedPermissionCapability,
  ): boolean;
  matchesRuleToolName(ruleToolName: string, contextToolName: string): boolean;
  requiresApproval(context: PermissionContext, toolCapability?: PermissionToolCapability): boolean;
  resolveCapability(
    context: PermissionContext,
    toolCapability?: PermissionToolCapability,
  ): ResolvedPermissionCapability;
  result(
    decision: PermissionBehavior,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason?: string,
  ): PermissionDecisionResult;
  ruleSubjects(input: unknown, toolName: string): string[];
  sessionRules: PermissionRuleset;
}
