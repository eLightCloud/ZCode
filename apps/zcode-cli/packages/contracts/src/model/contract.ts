/** 复用既有模型请求与调用上下文，不复制身份、用量或凭据结构。 */
export type { ModelTextRequest, ModelTextResult, ModelToolContract } from "./request-contract.js";
export type { ModelId, ModelProviderId } from "./model-identity.js";
export type { ModelInvocationContext } from "./invocation-context.js";
