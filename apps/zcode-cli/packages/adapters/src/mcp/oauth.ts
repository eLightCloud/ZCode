import { createHash, randomBytes } from "node:crypto";
import type { ZCodeMcpAuthorizationCodeProviderApi } from "./oauth-provider-api.js";
import type * as implementation2 from "./oauth-provider-credentials.js";
import { installZCodeMcpAuthorizationCodeProviderMethods } from "./oauth-provider-methods.js";
import type * as implementation1 from "./oauth-provider-verifier.js";

import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthTokens,
} from "@modelcontextprotocol/client";

import type { Logger } from "@zcode/contracts";

import {
  createLocalhostOAuthCallbackServer,
  type LocalhostOAuthCallbackServer,
} from "../auth/localhost-callback.js";

import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";

import { type McpOAuthCanonicalCredentials } from "./oauth-credentials.js";

import { type McpOAuthAuthorizationContext } from "./oauth-shared.js";

import {
  DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS,
  createCredentialKeyPrefix,
  normalizeCallbackPath,
} from "./oauth-provider-support.js";

import type {
  CredentialSnapshot,
  McpAuthorizationCodeOAuthConfig,
  McpOAuthRuntimeOptions,
  McpOAuthSession,
  StoredCredentialPair,
  TransactionClientSource,
} from "./oauth-provider-support.js";

export { createCredentialKeyPrefix } from "./oauth-provider-support.js";

export type { McpOAuthRuntimeOptions, McpOAuthSession } from "./oauth-provider-support.js";

export type { McpOAuthAuthorizationContext };

export async function createMcpAuthorizationCodeOAuthSession(input: {
  adapterInstanceId?: string;
  config: McpAuthorizationCodeOAuthConfig;
  logger?: Logger;
  options?: McpOAuthRuntimeOptions;
  serverName: string;
  serverUrl: string;
}): Promise<McpOAuthSession> {
  const state = randomBytes(24).toString("base64url");
  const callbackPath = normalizeCallbackPath(input.config.redirectPath, input.serverName);
  const callbackServer = await createLocalhostOAuthCallbackServer({
    callbackPath,
    state,
  });
  const credentialStore = input.options?.credentialStore ?? createSharedZCodeCredentialStore();
  const keyPrefix = createCredentialKeyPrefix(input.serverName, input.serverUrl, input.config);
  const provider = new ZCodeMcpAuthorizationCodeProvider({
    adapterInstanceId: input.adapterInstanceId,
    callbackServer,
    config: input.config,
    credentialStore,
    keyPrefix,
    logger: input.logger,
    onAuthorizationRequired: input.options?.onAuthorizationRequired,
    openAuthorizationUrl: input.options?.openAuthorizationUrl,
    serverName: input.serverName,
    state,
  });

  return {
    close: async () => {
      await callbackServer.close();
      await provider.close();
    },
    provider,
    timeoutMs: input.options?.authorizationTimeoutMs ?? DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS,
    hasPendingAuthorization: () => provider.hasPendingAuthorization(),
    waitForAuthorizationCallback: async () => {
      const callback = await callbackServer.waitForCallback();
      return new URL(callback.url).searchParams;
    },
  };
}

class ZCodeMcpAuthorizationCodeProvider implements OAuthClientProvider {
  // 类型声明无实例字段；实现由下方唯一安装器登记在同一 owner 原型。
  declare state: ZCodeMcpAuthorizationCodeProviderApi["state"];
  declare clientInformation: ZCodeMcpAuthorizationCodeProviderApi["clientInformation"];
  declare saveClientInformation: ZCodeMcpAuthorizationCodeProviderApi["saveClientInformation"];
  declare tokens: ZCodeMcpAuthorizationCodeProviderApi["tokens"];
  declare saveTokens: ZCodeMcpAuthorizationCodeProviderApi["saveTokens"];
  declare redirectToAuthorization: ZCodeMcpAuthorizationCodeProviderApi["redirectToAuthorization"];
  declare hasPendingAuthorization: ZCodeMcpAuthorizationCodeProviderApi["hasPendingAuthorization"];
  declare saveCodeVerifier: ZCodeMcpAuthorizationCodeProviderApi["saveCodeVerifier"];
  declare codeVerifier: ZCodeMcpAuthorizationCodeProviderApi["codeVerifier"];
  declare saveDiscoveryState: ZCodeMcpAuthorizationCodeProviderApi["saveDiscoveryState"];
  declare discoveryState: ZCodeMcpAuthorizationCodeProviderApi["discoveryState"];
  declare invalidateCredentials: ZCodeMcpAuthorizationCodeProviderApi["invalidateCredentials"];
  declare close: ZCodeMcpAuthorizationCodeProviderApi["close"];

  private readonly adapterInstanceId?: string;
  private readonly callbackServer: LocalhostOAuthCallbackServer;
  private readonly config: McpAuthorizationCodeOAuthConfig;
  private readonly credentialStore: SharedZCodeCredentialStore;
  private readonly keyPrefix: string;
  private readonly logger?: Logger;
  private readonly onAuthorizationRequired?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;
  private readonly openAuthorizationUrl?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;
  private readonly serverName: string;
  private readonly stateValue: string;
  private readonly transactionId: string;
  private canonicalSnapshot?: CredentialSnapshot<McpOAuthCanonicalCredentials>;
  private credentialSnapshotsLoaded = false;
  private legacyClientSnapshot?: CredentialSnapshot<OAuthClientInformationMixed>;
  private legacyTokensSnapshot?: CredentialSnapshot<OAuthTokens>;
  private storedCredentialPair?: StoredCredentialPair;
  private storedCredentialPairLoaded = false;
  private pendingAuthorization = false;
  private transactionClientInformation?: OAuthClientInformationMixed;
  private transactionClientSource?: TransactionClientSource;
  private verifierPersisted = false;

  constructor(input: {
    adapterInstanceId?: string;
    callbackServer: LocalhostOAuthCallbackServer;
    config: McpAuthorizationCodeOAuthConfig;
    credentialStore: SharedZCodeCredentialStore;
    keyPrefix: string;
    logger?: Logger;
    onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
    openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
    serverName: string;
    state: string;
  }) {
    this.adapterInstanceId = input.adapterInstanceId;
    this.callbackServer = input.callbackServer;
    this.config = input.config;
    this.credentialStore = input.credentialStore;
    this.keyPrefix = input.keyPrefix;
    this.logger = input.logger;
    this.onAuthorizationRequired = input.onAuthorizationRequired;
    this.openAuthorizationUrl = input.openAuthorizationUrl;
    this.serverName = input.serverName;
    this.stateValue = input.state;
    this.transactionId = createHash("sha256").update(input.state).digest("hex");
  }

  get redirectUrl(): string {
    return this.callbackServer.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.clientName ?? `ZCode ${this.serverName}`,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      ...(this.config.clientSecret ? { token_endpoint_auth_method: "client_secret_basic" } : {}),
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  declare private invalidateCredentialSnapshot: OmitThisParameter<
    typeof implementation2.invalidateCredentialSnapshot
  >;

  declare private loadCredentialSnapshots: OmitThisParameter<
    typeof implementation2.loadCredentialSnapshots
  >;

  private async parseJsonSnapshot<T>(
    key: string,
    raw: string | null | undefined,
  ): Promise<CredentialSnapshot<T> | undefined> {
    if (!raw) return undefined;
    try {
      return { raw, value: JSON.parse(raw) as T };
    } catch {
      await this.credentialStore.deleteIfValue(key, raw);
      return undefined;
    }
  }

  declare private loadStoredCredentialPair: OmitThisParameter<
    typeof implementation2.loadStoredCredentialPair
  >;

  declare private resetCredentialSnapshots: OmitThisParameter<
    typeof implementation2.resetCredentialSnapshots
  >;

  private async loadJson<T>(name: string): Promise<T | undefined> {
    const raw = await this.credentialStore.load(this.key(name));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      await this.credentialStore.deleteIfValue(this.key(name), raw);
      return undefined;
    }
  }

  declare private saveJson: OmitThisParameter<typeof implementation2.saveJson>;

  declare private key: OmitThisParameter<typeof implementation2.key>;

  /** 并发诊断日志只允许安全标识：PID、adapter id、credential key prefix、state 短哈希。 */
  declare private logContext: OmitThisParameter<typeof implementation2.logContext>;

  declare private verifierKey: OmitThisParameter<typeof implementation1.verifierKey>;

  declare private clearVerifier: OmitThisParameter<typeof implementation1.clearVerifier>;
}

export type InternalZCodeMcpAuthorizationCodeProvider = ZCodeMcpAuthorizationCodeProvider;

installZCodeMcpAuthorizationCodeProviderMethods(ZCodeMcpAuthorizationCodeProvider.prototype);
