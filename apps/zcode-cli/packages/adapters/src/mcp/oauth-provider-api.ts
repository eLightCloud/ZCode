import type {
  OAuthClientInformationMixed,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";

import * as implementation0 from "./oauth-provider-client.js";
import * as implementation2 from "./oauth-provider-credentials.js";
import * as implementation1 from "./oauth-provider-verifier.js";
export interface ZCodeMcpAuthorizationCodeProviderApi {
  state(...args: Parameters<typeof implementation0.state>): string;
  clientInformation(
    ...args: Parameters<typeof implementation0.clientInformation>
  ): Promise<OAuthClientInformationMixed | undefined>;
  saveClientInformation(
    ...args: Parameters<typeof implementation0.saveClientInformation>
  ): Promise<void>;
  tokens(...args: Parameters<typeof implementation0.tokens>): Promise<OAuthTokens | undefined>;
  saveTokens(...args: Parameters<typeof implementation0.saveTokens>): Promise<void>;
  redirectToAuthorization(
    ...args: Parameters<typeof implementation0.redirectToAuthorization>
  ): Promise<void>;
  hasPendingAuthorization(
    ...args: Parameters<typeof implementation0.hasPendingAuthorization>
  ): boolean;
  saveCodeVerifier(...args: Parameters<typeof implementation1.saveCodeVerifier>): Promise<void>;
  codeVerifier(...args: Parameters<typeof implementation1.codeVerifier>): Promise<string>;
  saveDiscoveryState(...args: Parameters<typeof implementation1.saveDiscoveryState>): Promise<void>;
  discoveryState(
    ...args: Parameters<typeof implementation1.discoveryState>
  ): Promise<OAuthDiscoveryState | undefined>;
  invalidateCredentials(
    ...args: Parameters<typeof implementation2.invalidateCredentials>
  ): ReturnType<typeof implementation2.invalidateCredentials>;
  close(...args: Parameters<typeof implementation2.close>): Promise<void>;
}
