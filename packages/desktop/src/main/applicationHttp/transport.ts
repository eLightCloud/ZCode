import {
  APPLICATION_HTTP_MAX_BYTES,
  type ApplicationHttpRequest,
  type ApplicationHttpResponse,
} from "@zcode/shared";
import { applicationHttpTarget, type ApplicationHttpConfiguration } from "./configuration.js";

interface TransportDependencies {
  cookies: { get(filter: { url: string; name: string }): Promise<Array<{ value: string }>> };
  fetch: (input: string, init: RequestInit) => Promise<Response>;
}

export function applicationHttpFailure(status: number, reason: string): ApplicationHttpResponse {
  return {
    status,
    headers: [
      ["content-type", "application/json"],
      ["cache-control", "no-store"],
    ],
    body: new TextEncoder().encode(JSON.stringify({ detail: reason })).buffer,
  };
}

export async function performApplicationHttp(
  config: ApplicationHttpConfiguration,
  input: ApplicationHttpRequest,
  dependencies: TransportDependencies,
  signal: AbortSignal,
): Promise<ApplicationHttpResponse> {
  const target = applicationHttpTarget(config, input.path);
  if (["GET", "HEAD"].includes(input.method) && input.body !== undefined)
    return applicationHttpFailure(400, "application_http_request_invalid");
  if (input.body !== undefined && input.contentType === undefined)
    return applicationHttpFailure(400, "application_http_request_invalid");
  const headers: Record<string, string> = { Origin: config.publicOrigin };
  if (input.contentType) headers["Content-Type"] = input.contentType;
  // 从同一 Main Cookie jar 逐请求读取，页面声明不能替代当前会话与 CSRF。
  if (!["GET", "HEAD"].includes(input.method)) {
    const csrf = await dependencies.cookies.get({ url: config.apiOrigin, name: config.csrfCookie });
    if (csrf[0]) headers[config.csrfHeader] = decodeURIComponent(csrf[0].value);
  }
  const response = await dependencies.fetch(target.href, {
    method: input.method,
    headers,
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    body: input.body,
    signal,
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > APPLICATION_HTTP_MAX_BYTES) {
          await reader.cancel();
          return applicationHttpFailure(502, "application_http_response_too_large");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const publicHeaders: [string, string][] = [["cache-control", "no-store"]];
  for (const name of ["content-type", "x-correlation-id"]) {
    const value = response.headers.get(name);
    if (value && value.length <= 256 && !/[\r\n]/u.test(value)) publicHeaders.push([name, value]);
  }
  return { status: response.status, headers: publicHeaders, body: body.buffer };
}
