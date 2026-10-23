import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/client";

import {
  MCP_OAUTH_CANONICAL_CREDENTIALS_KEY,
  MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS,
  deriveCredentialPair,
  isCanonicalCredentials,
  isRecord,
  type McpOAuthCanonicalCredentials,
} from "./oauth-credentials.js";

import type { ZCodeMcpAuthorizationCodeProviderMethodsContext } from "./oauth-provider-context.js";
import type { CredentialSnapshot, StoredCredentialPair } from "./oauth-provider-support.js";
export async function invalidateCredentials(
  this: ZCodeMcpAuthorizationCodeProviderMethodsContext,
  scope: "all" | "client" | "tokens" | "verifier" | "discovery",
) {
  // 修复原因：过去 refresh 失败只在 SDK 内部分类，ZCode 侧不留任何痕迹，事后无法区分
  // token 过期、被撤销、client mismatch 和服务端临时错误（见 docs/analysis 的可观测性缺口）。
  // SDK 不把 OAuth error code 传给 provider，但 invalidation scope 与之一一对应：
  // tokens ← invalid_grant；client/all ← invalid_client / unauthorized_client。
  this.logger?.warn("MCP OAuth credentials invalidated", {
    event: "mcp.oauth.credentials.invalidated",
    ...this.logContext(),
    invalidationScope: scope,
    status: "failed",
  });
  if (scope === "all" || scope === "client" || scope === "tokens") {
    await this.invalidateCredentialSnapshot(scope);
  }
  if (scope === "all" || scope === "verifier") {
    await this.clearVerifier();
  }
  if (scope === "all" || scope === "discovery") {
    await this.credentialStore.delete(this.key("discovery_state"));
  }
}

export async function close(this: ZCodeMcpAuthorizationCodeProviderMethodsContext): Promise<void> {
  // 修复原因：PKCE verifier 只属于当前 state。adapter 超时或关闭时必须清理本事务，
  // 不能再删除相同 MCP 配置下另一个并发授权正在等待的 verifier。清理属于 best-effort：
  // token exchange 已成功时，锁超时或损坏文件不能把主链路反转成连接失败。
  try {
    await this.clearVerifier();
  } catch (error) {
    this.logger?.warn("MCP OAuth verifier cleanup failed", {
      event: "mcp.oauth.verifier.cleanup_failed",
      adapterInstanceId: this.adapterInstanceId,
      error: error instanceof Error ? error.message : String(error),
      mcpServerName: this.serverName,
      oauthStateId: this.transactionId.slice(0, 16),
      processId: process.pid,
      status: "failed",
    });
  }
  this.transactionClientInformation = undefined;
  this.transactionClientSource = undefined;
  this.resetCredentialSnapshots();
}

export async function invalidateCredentialSnapshot(
  this: ZCodeMcpAuthorizationCodeProviderMethodsContext,
  scope: "all" | "client" | "tokens",
): Promise<void> {
  await this.loadCredentialSnapshots();
  const canonicalSnapshot = this.canonicalSnapshot;
  const expectedValues: Record<string, string> = {};
  if (canonicalSnapshot) {
    expectedValues[this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)] = canonicalSnapshot.raw;
  }
  if ((scope === "all" || scope === "client") && this.legacyClientSnapshot) {
    expectedValues[this.key("client_information")] = this.legacyClientSnapshot.raw;
  }
  if ((scope === "all" || scope === "client" || scope === "tokens") && this.legacyTokensSnapshot) {
    expectedValues[this.key("tokens")] = this.legacyTokensSnapshot.raw;
  }
  const deleted = await this.credentialStore.deleteIfValues(expectedValues);
  const canonicalDeleted = canonicalSnapshot
    ? deleted[this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)]
    : undefined;
  this.logger?.warn("MCP OAuth credential snapshot invalidation resolved", {
    event: "mcp.oauth.credentials.invalidate_snapshot",
    ...this.logContext(),
    canonicalDeleted,
    // canonicalDeleted=false 表示 compare-and-delete 失败：另一个事务已发布新 pair，
    // 本次失效必须保留 winner。这是并发收口的正常结果，不是错误。
    hadCanonicalSnapshot: Boolean(canonicalSnapshot),
    invalidationScope: scope,
    legacyClientDeleted: deleted[this.key("client_information")],
    legacyTokensDeleted: deleted[this.key("tokens")],
    status: canonicalDeleted === false ? "cancelled" : "completed",
  });

  if (scope === "all" || scope === "client") {
    this.transactionClientInformation = undefined;
    this.transactionClientSource = undefined;
  } else if (
    this.transactionClientSource === "canonical" ||
    (canonicalSnapshot && this.transactionClientSource === "legacy")
  ) {
    if (canonicalDeleted === false) {
      // 修复原因：当前快照已被其他进程替换时，失败方不能删除新 pair；清空本地缓存，
      // 让 SDK 的同一次重试重新读取获胜事务发布的 client/tokens。
      this.transactionClientInformation = undefined;
      this.transactionClientSource = undefined;
    } else if (canonicalDeleted === true) {
      // token 已失效但动态 client 仍可用于当前 provider 重新授权。
      this.transactionClientSource = "registered";
    }
  }

  this.resetCredentialSnapshots();
}

export async function loadCredentialSnapshots(
  this: ZCodeMcpAuthorizationCodeProviderMethodsContext,
): Promise<void> {
  if (this.credentialSnapshotsLoaded) return;
  const canonicalKey = this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const legacyClientKey = this.key("client_information");
  const legacyTokensKey = this.key("tokens");
  const values = await this.credentialStore.loadMany([
    canonicalKey,
    legacyClientKey,
    legacyTokensKey,
  ]);
  const parsedCanonicalSnapshot = await this.parseJsonSnapshot<McpOAuthCanonicalCredentials>(
    canonicalKey,
    values[canonicalKey],
  );
  let canonicalSnapshot: CredentialSnapshot<McpOAuthCanonicalCredentials> | undefined;
  if (
    parsedCanonicalSnapshot &&
    isRecord(parsedCanonicalSnapshot.value) &&
    typeof parsedCanonicalSnapshot.value.version === "number" &&
    !MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS.has(parsedCanonicalSnapshot.value.version)
  ) {
    // 修复原因：CLI 与 desktop 会独立升级但共享凭据文件。旧版本只能忽略未知版本，
    // 不能把新版本写入的 canonical pair 当损坏数据删除。
  } else if (parsedCanonicalSnapshot && !isCanonicalCredentials(parsedCanonicalSnapshot.value)) {
    await this.credentialStore.deleteIfValue(canonicalKey, parsedCanonicalSnapshot.raw);
  } else {
    canonicalSnapshot = parsedCanonicalSnapshot;
  }
  const legacyClientSnapshot = await this.parseJsonSnapshot<OAuthClientInformationMixed>(
    legacyClientKey,
    values[legacyClientKey],
  );
  const legacyTokensSnapshot = await this.parseJsonSnapshot<OAuthTokens>(
    legacyTokensKey,
    values[legacyTokensKey],
  );

  // 修复原因：共享凭据读取可能因锁超时或临时 I/O 失败而抛错。只有完整快照成功后
  // 才发布缓存和 loaded 标志，确保同一个 provider 的下一次调用仍会重试。
  this.canonicalSnapshot = canonicalSnapshot;
  this.legacyClientSnapshot = legacyClientSnapshot;
  this.legacyTokensSnapshot = legacyTokensSnapshot;
  this.credentialSnapshotsLoaded = true;
}

export async function loadStoredCredentialPair(
  this: ZCodeMcpAuthorizationCodeProviderMethodsContext,
): Promise<StoredCredentialPair | undefined> {
  if (this.storedCredentialPairLoaded) return this.storedCredentialPair;
  await this.loadCredentialSnapshots();
  // 委托给共享的纯函数：canonical 与 legacy 镜像的交错兼容规则只能有一份，两处各写一遍必然
  // 发散。用已经读到的快照派生，不再多读一次凭据文件；快照本身仍留在本类里，因为
  // compare-and-delete 需要发起方读到的原始值。
  const pair = deriveCredentialPair({
    canonicalRaw: this.canonicalSnapshot?.raw,
    legacyClientRaw: this.legacyClientSnapshot?.raw,
    legacyTokensRaw: this.legacyTokensSnapshot?.raw,
  });
  this.storedCredentialPair = pair
    ? {
        ...(pair.clientInformation ? { clientInformation: pair.clientInformation } : {}),
        source: pair.source,
        ...(pair.tokens ? { tokens: pair.tokens } : {}),
      }
    : undefined;
  this.storedCredentialPairLoaded = true;
  return this.storedCredentialPair;
}

export function resetCredentialSnapshots(
  this: ZCodeMcpAuthorizationCodeProviderMethodsContext,
): void {
  this.canonicalSnapshot = undefined;
  this.credentialSnapshotsLoaded = false;
  this.legacyClientSnapshot = undefined;
  this.legacyTokensSnapshot = undefined;
  this.storedCredentialPair = undefined;
  this.storedCredentialPairLoaded = false;
}

export async function saveJson(
  this: ZCodeMcpAuthorizationCodeProviderMethodsContext,
  name: string,
  value: unknown,
): Promise<void> {
  await this.credentialStore.save(this.key(name), JSON.stringify(value));
}

export function key(this: ZCodeMcpAuthorizationCodeProviderMethodsContext, name: string): string {
  return `${this.keyPrefix}:${name}`;
}

/** 并发诊断日志只允许安全标识：PID、adapter id、credential key prefix、state 短哈希。 */

export function logContext(
  this: ZCodeMcpAuthorizationCodeProviderMethodsContext,
): Record<string, unknown> {
  return {
    adapterInstanceId: this.adapterInstanceId,
    credentialKeyPrefix: this.keyPrefix,
    mcpServerName: this.serverName,
    oauthStateId: this.transactionId.slice(0, 16),
    processId: process.pid,
  };
}
