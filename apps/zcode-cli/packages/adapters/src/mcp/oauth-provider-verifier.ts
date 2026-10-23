import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";

import { loadDiscoveryRecord, saveDiscoveryRecord } from "./oauth-shared.js";

import type { ZCodeMcpAuthorizationCodeProviderMethodsContext } from "./oauth-provider-context.js";
export async function saveCodeVerifier(
  this: ZCodeMcpAuthorizationCodeProviderMethodsContext,
  codeVerifier: string,
): Promise<void> {
  await this.credentialStore.save(this.verifierKey(), codeVerifier);
  this.verifierPersisted = true;
}

export async function codeVerifier(
  this: ZCodeMcpAuthorizationCodeProviderMethodsContext,
): Promise<string> {
  const codeVerifier = await this.credentialStore.load(this.verifierKey());
  if (!codeVerifier) {
    throw new Error(`Missing MCP OAuth PKCE verifier for ${this.serverName}`);
  }
  this.verifierPersisted = true;
  return codeVerifier;
}

export async function saveDiscoveryState(
  this: ZCodeMcpAuthorizationCodeProviderMethodsContext,
  state: OAuthDiscoveryState,
): Promise<void> {
  // 与 Phase 2 共用同一份带时间戳的 discovery 记录：否则一侧刷新了 AS metadata，另一侧
  // 仍可能使用无 TTL 的旧缓存。
  await saveDiscoveryRecord(this.credentialStore, this.keyPrefix, state);
}

export async function discoveryState(
  this: ZCodeMcpAuthorizationCodeProviderMethodsContext,
): Promise<OAuthDiscoveryState | undefined> {
  return await loadDiscoveryRecord(this.credentialStore, this.keyPrefix);
}

export function verifierKey(this: ZCodeMcpAuthorizationCodeProviderMethodsContext): string {
  return this.key(`code_verifier:${this.stateValue}`);
}

export async function clearVerifier(
  this: ZCodeMcpAuthorizationCodeProviderMethodsContext,
): Promise<void> {
  if (!this.verifierPersisted) return;
  await this.credentialStore.delete(this.verifierKey());
  this.verifierPersisted = false;
}
