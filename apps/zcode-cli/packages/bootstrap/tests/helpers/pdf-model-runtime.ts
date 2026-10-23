import { AiSdkModelAdapter } from "@zcode/adapters/model";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
} from "@zcode/provider";
import { ApiProviderModelRuntime } from "../../src/app/provider-registry-model-runtime.js";
import { createApiKeyProviderConfig } from "../provider-config-fixtures.js";

/** PDF 回归经过当前 Registry → ModelFactory → 真正 SDK，不恢复已退役 ModelRegistry。 */
export function createPdfModelRuntime(
  baseURL: string,
  providerId: string,
  models: Readonly<Record<string, boolean>>,
) {
  const registry = new ProviderRegistry([
    {
      providerId,
      config: createApiKeyProviderConfig({
        apiFormat: "openai-chat-completions",
        apiKey: "pdf-e2e-key",
        baseURL: `${baseURL}/v1`,
        models: Object.keys(models),
      }),
      models: Object.entries(models).map(([modelId, supportsPdf]) => ({
        modelId,
        config: new ModelConfig({
          enabled: true,
          visibility: "visible",
          properties: new ModelPropertiesConfig({
            requiresMfjsToolSchema: false,
            contextWindow: 200_000,
            inputFormat: {
              supportsText: true,
              supportsImage: true,
              supportsVideo: false,
              supportsAudio: false,
              supportsPdf,
            },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsJsonSchemaOutput: false,
            supportsNativeWebSearch: false,
            supportsMidConversationSystem: false,
          }),
          optionSpecs: new ModelOptionSpecsConfig({
            reasoningLevel: { values: ["disabled"], map: "{}" },
            maxOutputTokens: { max: 32_000, map: "{'max_tokens': maxOutputTokens}" },
          }),
        }),
      })),
    },
  ]);
  const runtime = new ApiProviderModelRuntime({
    registry,
    modelAdapter: new AiSdkModelAdapter({ retry: { maxAttempts: 1 } }),
  });
  runtime.start();
  return { registry, modelFactory: runtime.modelFactory };
}
