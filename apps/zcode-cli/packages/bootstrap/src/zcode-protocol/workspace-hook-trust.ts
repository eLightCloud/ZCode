import { workspaceHookPolicySchema } from "@zcode/contracts";
import type { WorkspaceHookPolicyProvider } from "@zcode/core";
import {
  zcodeWorkspaceHookTrustGrantParamsSchema,
  zcodeWorkspaceHookTrustGrantReasonCodeSchema,
  zcodeWorkspaceHookTrustGrantResultSchema,
  type ZCodeWorkspaceHookTrustGrantReasonCode,
  type ZCodeWorkspaceHookTrustGrantResult,
} from "@zcode/shared";
import { resolve } from "node:path";
import {
  grantWorkspaceHookTrust,
  type WorkspaceHookTrustCliStatus,
} from "../workspace-hook-trust-cli.js";

type GrantWorkspaceHookTrust = typeof grantWorkspaceHookTrust;

/**
 * 没有 task/session 时的 workspace 级 Trust authority。
 *
 * 可信 Host 只能提交 Settings 看到的精确 bundle/declaration；真正授权前仍由 Agent
 * 重新发现 canonical snapshot。这里不创建隐藏 task，也不接受 UI 直接提供的记录内容。
 */
export async function grantWorkspaceHookTrustForProtocol(
  rawParams: unknown,
  dependencies: {
    appVersion?: string;
    grant?: GrantWorkspaceHookTrust;
    policyProvider: WorkspaceHookPolicyProvider;
  },
): Promise<ZCodeWorkspaceHookTrustGrantResult> {
  const params = zcodeWorkspaceHookTrustGrantParamsSchema.parse(rawParams);
  const grant = dependencies.grant ?? grantWorkspaceHookTrust;
  const workspaceIdentity =
    params.workspace.workspaceIdentity?.trim() || resolve(params.workspace.workspacePath);
  const policyRejection = getPolicyRejectionReason(dependencies.policyProvider, workspaceIdentity);
  if (policyRejection) {
    return zcodeWorkspaceHookTrustGrantResultSchema.parse({
      accepted: false,
      reasonCode: policyRejection,
    });
  }
  try {
    const status = await grant({
      workspacePath: params.workspace.workspacePath,
      ...(params.workspace.workspaceIdentity
        ? { workspaceIdentity: params.workspace.workspaceIdentity }
        : {}),
      bundleDigest: params.bundleDigest,
      hookDeclarationDigests: [params.hookDeclarationDigest],
      ...(dependencies.appVersion ? { appVersion: dependencies.appVersion } : {}),
    });
    return zcodeWorkspaceHookTrustGrantResultSchema.parse(
      didGrantExactDeclaration(status, params.hookDeclarationDigest)
        ? { accepted: true }
        : { accepted: false, reasonCode: toPublicReasonCode(status.reasonCode) },
    );
  } catch (error) {
    return zcodeWorkspaceHookTrustGrantResultSchema.parse({
      accepted: false,
      reasonCode: toPublicReasonCode(error),
    });
  }
}

function getPolicyRejectionReason(
  policyProvider: WorkspaceHookPolicyProvider,
  workspaceIdentity: string,
): ZCodeWorkspaceHookTrustGrantReasonCode | undefined {
  try {
    const policy = workspaceHookPolicySchema.parse(policyProvider.getPolicy(workspaceIdentity));
    if (policy.mode === "user_decides") return undefined;
    return policy.mode === "allow_trusted_only"
      ? "workspace_hooks_policy_requires_pretrust"
      : "workspace_hooks_blocked_by_policy";
  } catch {
    // Settings 无 session 路径曾在重新发现后直接写 Trust store，绕过受信
    // embedder policy。policy provider 异常时也必须 fail closed，不能退回默认可授权。
    return "workspace_hooks_blocked_by_policy";
  }
}

function toPublicReasonCode(error: unknown): ZCodeWorkspaceHookTrustGrantReasonCode {
  const candidate = error instanceof Error ? error.message : error;
  const parsed = zcodeWorkspaceHookTrustGrantReasonCodeSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  // 这里曾把底层 Error.message 直接放进 reasonCode，导致配置绝对路径和
  // 用户名越过 Agent/Host/UI 协议边界。未知异常只能收敛到公开稳定码，不能透传文本。
  return "workspace_hooks_config_unreadable";
}

function didGrantExactDeclaration(
  status: WorkspaceHookTrustCliStatus,
  hookDeclarationDigest: string,
): boolean {
  return status.items.some(
    (item) =>
      item.hookDeclarationDigest === hookDeclarationDigest &&
      item.trustState === "trusted_persistent",
  );
}

import { notifyWorkspaceHookTrustGrantSessions } from "./protocol-server-support.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** 授权与已加载会话镜像通知属于同一协议操作；接纳、日志和重载仍由既有 owner 负责。 */
export async function grantWorkspaceHookTrustAndNotifySessions(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const grantResult = await grantWorkspaceHookTrustForProtocol(rawParams, {
    appVersion: context.deps.version,
    policyProvider: context.deps.workspaceHookPolicyProvider,
  });
  if (grantResult.accepted) {
    await notifyWorkspaceHookTrustGrantSessions({
      // dispatch 层的 params 是弱类型；grant 内部已用同一 schema parse 过，这里
      // safeParse 只为取出 workspaceKey 做匹配，失败即跳过通知（防御，正常必成功）。
      grantedWorkspaceKey: zcodeWorkspaceHookTrustGrantParamsSchema.safeParse(rawParams).success
        ? zcodeWorkspaceHookTrustGrantParamsSchema.parse(rawParams).workspace.workspaceKey
        : undefined,
      sessions: context.sessions,
    });
  }
  return grantResult;
}
