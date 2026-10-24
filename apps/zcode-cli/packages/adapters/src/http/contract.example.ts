import type { HttpClientPort } from "./contract.js";

/** 调用者明确指定目标 / 取消信号，既有适配器继续处理超时、代理及可观测错误。 */
export function requestThroughNativeHttp(client: HttpClientPort, url: string, signal: AbortSignal) {
  return client.request({ url }, { signal });
}
