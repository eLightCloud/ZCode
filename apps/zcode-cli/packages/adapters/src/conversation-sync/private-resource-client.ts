import { createTraceId, type HttpClientPort } from "@zcode/contracts";
import { ConversationRuntimeError } from "@zcode/shared";
import { z } from "zod";

/** Two fixed native resource channels share trusted origin and bounded transport semantics. */
export function createNativeResourceClient(options: {
  url: string;
  proof: string;
  httpClient: HttpClientPort;
  trustedHttpOrigin?: string;
}) {
  const base = new URL(options.url);
  if (
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    options.proof.length < 32 ||
    options.proof.length > 512 ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        (["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
          base.origin === options.trustedHttpOrigin)
      ))
  )
    throw new ConversationRuntimeError("configuration");
  return async (
    path: "/api/native/conversation-runtime" | "/api/native/conversation-bytes",
    value: unknown,
  ) => {
    const response = await options.httpClient.request({
      url: base.origin + path,
      method: "POST",
      headers: { authorization: "Bearer " + options.proof, "content-type": "application/json" },
      redirect: "manual",
      body: Buffer.from(JSON.stringify(value)),
      timeoutMs: 30000,
      maxResponseBytes: 32 * 1024 * 1024,
      trace: { traceId: createTraceId() },
    });
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(response.body).toString("utf8"));
    } catch {
      throw new ConversationRuntimeError("unavailable");
    }
    if (response.status !== 200) {
      const failure = z
        .object({
          error: z
            .string()
            .regex(/^[a-zA-Z0-9_.:-]{1,128}$/)
            .optional(),
          detail: z
            .string()
            .regex(/^[a-zA-Z0-9_.:-]{1,128}$/)
            .optional(),
        })
        .safeParse(body);
      throw new ConversationRuntimeError(
        response.status === 409 && failure.success
          ? (failure.data.error ?? failure.data.detail ?? "unavailable")
          : "unavailable",
      );
    }
    return body;
  };
}
