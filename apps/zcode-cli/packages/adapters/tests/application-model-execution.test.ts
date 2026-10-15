import { generateText, streamText } from "ai";
import { runWithModelInvocationContext } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  serializeRegistryProviderConfig,
  type RegistryProviderConfig,
} from "@zcode/provider";
import { AiSdkModelExecution } from "../src/model/model-execution.js";

const token = "synthetic-native-workload-token-0123456789";
const baseURL = "http://127.0.0.1:3101/api/system-models/v1";
function config(
  group: "application-managed" | "standard-personal" = "application-managed",
  base = baseURL,
) {
  return new ProviderConfig({
    group,
    access: new ApiKeyAccessConfig({
      apiKey: group === "application-managed" ? "application-managed" : "synthetic-personal-key",
    }),
    api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: base }),
  }) as RegistryProviderConfig;
}
function bind(execution: AiSdkModelExecution, providerConfig = config()) {
  return execution.bindModel({
    providerId: "application:test",
    modelId: "synthetic-model",
    providerConfig,
    supportsJsonSchemaOutput: false,
    optionSpecs: {
      reasoningLevel: { map: "{}" },
      maxOutputTokens: { map: '{"max_tokens": maxOutputTokens}' },
    },
  });
}
describe("application managed model boundary", () => {
  it.each(["generate", "stream"] as const)(
    "rejects an Automation %s call on an existing handle before transport",
    async (mode) => {
      const transport = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "synthetic",
              object: "chat.completion",
              created: 1,
              model: "synthetic-model",
              choices: [
                { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      );
      const execution = new AiSdkModelExecution(
        {
          env: {
            ZCODE_APPLICATION_MODEL_TOKEN: token,
            ZCODE_APPLICATION_MODEL_BASE_URL: baseURL,
          },
        },
        { transport: transport as typeof fetch },
      );
      const model = bind(execution).resolveRequest({
        options: { reasoningLevel: "disabled", maxOutputTokens: 16 },
      }).model;
      await expect(
        runWithModelInvocationContext({ modelRequestPurpose: "automation" }, async () => {
          if (mode === "generate")
            await generateText({ model, prompt: "synthetic", maxRetries: 0 });
          else {
            const result = streamText({
              model,
              prompt: "synthetic",
              maxRetries: 0,
              onError: () => {},
            });
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error;
            }
          }
        }),
      ).rejects.toThrow("application_automation_credentials_unavailable");
      expect(transport).not.toHaveBeenCalled();
      // 同一个句柄的后续人工调用不能粘住上一轮自动化限制。
      await expect(
        generateText({ model, prompt: "synthetic", maxRetries: 0 }),
      ).resolves.toMatchObject({ text: "ok" });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps the private token out of config and sends it only through the native adapter", async () => {
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + token);
      return new Response(
        JSON.stringify({
          id: "synthetic",
          object: "chat.completion",
          created: 1,
          model: "synthetic-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const provider = config();
    expect(JSON.stringify(serializeRegistryProviderConfig(provider))).not.toContain(token);
    const execution = new AiSdkModelExecution(
      { env: { ZCODE_APPLICATION_MODEL_TOKEN: token, ZCODE_APPLICATION_MODEL_BASE_URL: baseURL } },
      { transport: transport as typeof fetch },
    );
    const bound = bind(execution, provider);
    await expect(
      generateText({
        model: bound.resolveRequest({
          options: { reasoningLevel: "disabled", maxOutputTokens: 16 },
        }).model,
        prompt: "synthetic",
      }),
    ).resolves.toMatchObject({ text: "ok" });
    expect(JSON.stringify(serializeRegistryProviderConfig(provider))).not.toContain(token);
  });
  it("rejects a modified endpoint and missing private identity before any network call", () => {
    const transport = vi.fn();
    const execution = new AiSdkModelExecution(
      { env: { ZCODE_APPLICATION_MODEL_TOKEN: token, ZCODE_APPLICATION_MODEL_BASE_URL: baseURL } },
      { transport },
    );
    expect(() => bind(execution, config("application-managed", "https://example.com/v1"))).toThrow(
      "application_model_credentials_unavailable",
    );
    expect(() => bind(new AiSdkModelExecution({ env: {} }, { transport }))).toThrow(
      "application_model_credentials_unavailable",
    );
    expect(transport).not.toHaveBeenCalled();
  });
  it("leaves personal providers on their own API-key path", () => {
    const provider = config("standard-personal");
    expect(() => bind(new AiSdkModelExecution({ env: {} }), provider)).not.toThrow();
    expect(serializeRegistryProviderConfig(provider).access).toMatchObject({
      apiKey: "synthetic-personal-key",
    });
  });
  it("lets a personal-provider Automation use its own key on the same managed host", async () => {
    const transport = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-personal-key");
      return new Response(
        JSON.stringify({
          id: "synthetic",
          object: "chat.completion",
          created: 1,
          model: "synthetic-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const execution = new AiSdkModelExecution(
      {
        env: {
          ZCODE_APPLICATION_MODEL_TOKEN: token,
          ZCODE_APPLICATION_MODEL_BASE_URL: baseURL,
        },
      },
      { transport: transport as typeof fetch },
    );
    const bound = bind(execution, config("standard-personal"));
    await expect(
      runWithModelInvocationContext({ modelRequestPurpose: "automation" }, () =>
        generateText({
          model: bound.resolveRequest({
            options: { reasoningLevel: "disabled", maxOutputTokens: 16 },
          }).model,
          prompt: "synthetic",
          maxRetries: 0,
        }),
      ),
    ).resolves.toMatchObject({ text: "ok" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
