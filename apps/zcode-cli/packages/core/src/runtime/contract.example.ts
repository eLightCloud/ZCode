import type { AgentRuntimeInputApi } from "./agent-runtime-input-api.js";
import type { PromptAdmissionOptions } from "./contract.js";

/** 调用原生接纳入口；协议 / 企业装配不另建 accepted queue。 */
export async function admitThroughNativeRuntime(
  runtime: AgentRuntimeInputApi,
  text: string,
  options?: PromptAdmissionOptions,
) {
  return runtime.admitPrompt(text, undefined, options);
}
