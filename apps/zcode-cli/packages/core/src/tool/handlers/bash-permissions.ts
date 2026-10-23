// ============================================================
// Bash Tool Handler
// ============================================================

import { matchDangerousCommand } from "./guarded/command.js";

import { type ExecutionShellSelection } from "@zcode/contracts";

import type {
  ToolRuntimePermissionCapability,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";

import { readStringProperty } from "./bash-metadata.js";

import { createBashProviderDescription } from "./bash-prompt.js";

import {
  isBashReadOnlyCommand,
  isRuntimeReadOnlyBashCommand,
  prepareBashPermissionMatcherForCommand,
  type BashPermissionMatcher,
} from "./bash-semantics.js";

import { DEFAULT_BASH_TIMEOUT_POLICY, type BashTimeoutPolicy } from "../bash-timeout-policy.js";

/** session shell selection 尚未初始化时 guarded matcher 采用的文法；与 readonly 判定的假设一致。 */
export const GUARDED_DEFAULT_DIALECT: ExecutionShellSelection["dialect"] = "posix";

export const BASH_PROVIDER_DESCRIPTION = createBashProviderDescription({
  defaultTimeoutMs: DEFAULT_BASH_TIMEOUT_POLICY.defaultTimeoutMs,
  maxTimeoutMs: DEFAULT_BASH_TIMEOUT_POLICY.maxTimeoutMs,
});

export function getBashPrompt(
  timeoutPolicy: BashTimeoutPolicy = DEFAULT_BASH_TIMEOUT_POLICY,
): string {
  return createBashProviderDescription({
    defaultTimeoutMs: timeoutPolicy.defaultTimeoutMs,
    maxTimeoutMs: timeoutPolicy.maxTimeoutMs,
  });
}

export function isBashInputReadOnly(input: unknown): boolean {
  const command = readStringProperty(input, "command");
  return command ? isBashReadOnlyCommand(command) : false;
}

export function isBashInputConcurrencySafe(input: unknown): boolean {
  return isBashInputReadOnly(input);
}

export function checkBashInputPermissions(input: unknown): { behavior: "allow" } | undefined {
  return resolveBashPermissionCapability(input) ? { behavior: "allow" } : undefined;
}

export function prepareBashPermissionMatcher(input: unknown): BashPermissionMatcher | undefined {
  const command = readStringProperty(input, "command");
  return command === undefined ? undefined : prepareBashPermissionMatcherForCommand(command);
}

export function resolveBashPermissionCapability(
  input: unknown,
  context?: ToolRuntimePermissionCapabilityContext,
): ToolRuntimePermissionCapability | undefined {
  const command = readStringProperty(input, "command");
  if (command && context?.mode === "guarded") {
    // selection 缺失是基础设施状态而非语法边界；与下方 isRuntimeReadOnlyBashCommand 一致按 POSIX
    // 文法匹配，避免 guarded 在 selection 尚未初始化时静默退回 YOLO。显式 legacy-shell 仍 unsupported。
    const match = matchDangerousCommand(
      command,
      context.bashShellSelection?.dialect ?? GUARDED_DEFAULT_DIALECT,
    );
    if (match.status === "matched") return { userApprovalRule: match.ruleId };
  }
  if (!command || !isRuntimeReadOnlyBashCommand(command, context)) return undefined;
  return {
    destructive: false,
    needsApproval: false,
    readOnly: true,
    riskLevel: "low" as const,
    sideEffectScope: "none" as const,
    permission: {
      needsApproval: false,
      riskLevel: "low" as const,
      sideEffectScope: "none" as const,
    },
  };
}
