import type { OAuthClientInformationMixed } from "@modelcontextprotocol/client";
import type { OAuthTokens } from "@modelcontextprotocol/client";
import type { Logger } from "@zcode/contracts";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import type { McpOAuthCanonicalCredentials } from "./oauth-credentials.js";
import type { CredentialSnapshot } from "./oauth-provider-support.js";
import type { McpAuthorizationCodeOAuthConfig } from "./oauth-provider-support.js";
import type { StoredCredentialPair } from "./oauth-provider-support.js";
import type { TransactionClientSource } from "./oauth-provider-support.js";

/** 唯一 owner 的内部状态 / 协作合同；不从实现反向取型，不创建副本。 */
export interface ZCodeMcpAuthorizationCodeProviderMethodsContext {
  readonly adapterInstanceId: string | undefined;
  canonicalSnapshot: CredentialSnapshot<McpOAuthCanonicalCredentials> | undefined;
  clearVerifier(): Promise<void>;
  clientInformation(): Promise<OAuthClientInformationMixed | undefined>;
  readonly config: McpAuthorizationCodeOAuthConfig;
  credentialSnapshotsLoaded: boolean;
  readonly credentialStore: SharedZCodeCredentialStore;
  invalidateCredentialSnapshot(scope: "all" | "client" | "tokens"): Promise<void>;
  key(name: string): string;
  readonly keyPrefix: string;
  legacyClientSnapshot: CredentialSnapshot<OAuthClientInformationMixed> | undefined;
  legacyTokensSnapshot: CredentialSnapshot<OAuthTokens> | undefined;
  loadCredentialSnapshots(): Promise<void>;
  loadStoredCredentialPair(): Promise<StoredCredentialPair | undefined>;
  logContext(): Record<string, unknown>;
  readonly logger: Logger | undefined;
  parseJsonSnapshot<T>(
    key: string,
    raw: string | null | undefined,
  ): Promise<CredentialSnapshot<T> | undefined>;
  pendingAuthorization: boolean;
  readonly redirectUrl: string;
  resetCredentialSnapshots(): void;
  readonly serverName: string;
  readonly stateValue: string;
  storedCredentialPair: StoredCredentialPair | undefined;
  storedCredentialPairLoaded: boolean;
  transactionClientInformation: OAuthClientInformationMixed | undefined;
  transactionClientSource: TransactionClientSource | undefined;
  readonly transactionId: string;
  verifierKey(): string;
  verifierPersisted: boolean;
}
