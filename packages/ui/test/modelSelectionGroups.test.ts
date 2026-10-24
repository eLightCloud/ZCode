import { describe, expect, it } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { buildRegistryModelSelectGroups as buildNativeModelGroups } from "../src/lib/modelSelectionGroups.js";
import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigResolver,
  parseZCodeBuiltinModelConfigRules,
  parseZCodeBuiltinProviderConfigRules,
} from "@zcode/provider";
import builtinRelease from "../../../config/provider/zcode-builtin.json";

const buildRegistryModelSelectGroups: typeof buildNativeModelGroups = (provider, view, labels) =>
  buildNativeModelGroups(provider, view, { ...labels, applicationGrouping: true });

describe("model selection groups", () => {
  it.each([null, undefined, { revision: 1, providers: [] }])(
    "keeps both sections without any provider, including before loading: %j",
    (view) => {
      expect(buildRegistryModelSelectGroups("glm", view)).toMatchObject([
        { key: "application-models:system", directItems: true, items: [] },
        { key: "application-models:personal", directItems: true, items: [] },
      ]);
    },
  );
  it("keeps both sections after the real resolver removes an empty managed provider", () => {
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: parseZCodeBuiltinProviderConfigRules({
        templateRules: [],
        providerRules: [
          {
            providerId: "application:empty",
            enabled: true,
            config: {
              group: "application-managed",
              access: { type: "api-key", apiKey: "application-managed" },
              api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
              builtinModelIds: [],
            },
          },
        ],
      }).providers,
      zcodeBuiltinModelRules: parseZCodeBuiltinModelConfigRules(
        builtinRelease.config.modelConfigRules,
      ),
      personalProviders: new ProviderConfigMap(),
      accountProviders: new ProviderConfigMap(),
      personalModels: new ModelConfigRules(),
    });
    expect(result.registryProviders).toEqual([]);
    expect(
      buildRegistryModelSelectGroups("glm", {
        revision: 1,
        providers: result.registryProviders,
      }).map((group) => group.key),
    ).toEqual(["application-models:system", "application-models:personal"]);
  });
  it("shows personal models without a managed provider", () => {
    const groups = buildRegistryModelSelectGroups("glm", {
      revision: 1,
      providers: [
        {
          providerId: "personal",
          providerName: "My provider",
          config: { group: "standard-personal", api: { type: "openai-chat-completions" } },
          models: [{ modelId: "personal-model", config: {} }],
        },
      ],
    });
    expect(groups[0]!.items).toEqual([]);
    expect(groups[1]!.items).toMatchObject([{ name: "personal-model", badgeLabel: "My provider" }]);
  });
  it("keeps both application sections before a personal provider or any system model is available", () => {
    const view: ModelSelectionView = {
      revision: 1,
      providers: [
        {
          providerId: "application:fixture",
          config: { group: "application-managed", api: { type: "openai-chat-completions" } },
          models: [],
        },
      ],
    };
    expect(
      buildRegistryModelSelectGroups("glm", view).map(({ key, items }) => ({ key, items })),
    ).toEqual([
      { key: "application-models:system", items: [] },
      { key: "application-models:personal", items: [] },
    ]);
  });
  it("separates managed and personal models while preserving provider identities", () => {
    const view: ModelSelectionView = {
      revision: 1,
      providers: [
        {
          providerId: "application:fixture",
          providerName: "Managed",
          config: { group: "application-managed", api: { type: "openai-chat-completions" } },
          models: [{ modelId: "same-name", config: {} }],
        },
        {
          providerId: "personal",
          providerName: "My provider",
          config: { group: "standard-personal", api: { type: "openai-chat-completions" } },
          models: [{ modelId: "same-name", config: {} }],
        },
      ],
    };
    const groups = buildRegistryModelSelectGroups("glm", view);
    expect(groups.map((group) => group.key)).toEqual([
      "application-models:system",
      "application-models:personal",
    ]);
    expect(groups.every((group) => group.directItems)).toBe(true);
    expect(groups[0]!.items[0]!.value).not.toBe(groups[1]!.items[0]!.value);
    expect(groups[1]!.items[0]!.badgeLabel).toBe("My provider");
  });
  it.each([
    [{ type: "zhipu-account", accountType: "zai", mode: "individual-coding-plan" }, false],
    [{ type: "zhipu-account", accountType: "bigmodel", mode: "team-coding-plan" }, false],
    [{ type: "zhipu-coding-plan-api-key" }, false],
    [{ type: "zhipu-account", accountType: "zai", mode: "start-plan" }, false],
    [{ type: "zhipu-account", accountType: "bigmodel", mode: "start-plan" }, false],
    [{ type: "zhipu-account", accountType: "bigmodel", mode: "off-peak" }, true],
    [{ type: "api-key" }, true],
  ])("仅套餐 GLM-5.3 隐藏视觉标，不影响 Flash/真实能力：%j", (access, expected) => {
    const view: ModelSelectionView = {
      revision: 1,
      providers: [
        {
          providerId: "fixture",
          config: {
            logo: { type: "builtin", key: "deepseek" },
            access: access as ModelSelectionView["providers"][number]["config"]["access"],
            api: { type: "anthropic-messages" },
          },
          models: ["GLM-5.3", "GLM-5.3-Flash", "GLM-4.7"].map((modelId) => ({
            modelId,
            config: { properties: { inputFormat: { supportsImage: true } } },
          })),
        },
      ],
    };
    const items = buildRegistryModelSelectGroups("glm", view).find(
      (group) => group.key === "registry-provider:fixture",
    )!.items;
    expect(items[0]!.supportsVisionInput === true).toBe(expected);
    expect(items[1]!.supportsVisionInput).toBe(true);
    expect(items[2]!.supportsVisionInput).toBe(true);
    expect(view.providers[0]!.models[0]!.config.properties?.inputFormat?.supportsImage).toBe(true);
  });
  it("保留带前缀和多段斜杠的精确模型 ID；不从名称推断视觉能力", () => {
    const modelId = "upstream/family/vision-preview";
    const view: ModelSelectionView = {
      revision: 1,
      providers: [
        {
          providerId: "aggregator",
          config: { api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" } },
          models: [{ modelId, config: { properties: { inputFormat: { supportsImage: true } } } }],
        },
      ],
    };
    expect(
      buildRegistryModelSelectGroups("glm", view).find(
        (group) => group.key === "registry-provider:aggregator",
      )?.items,
    ).toEqual([
      {
        key: `registry-provider:aggregator:${modelId}`,
        value: "custom:aggregator:upstream%2Ffamily%2Fvision-preview",
        name: modelId,
        supportsVisionInput: true,
      },
    ]);
    view.providers[0]!.models[0]!.config = {};
    expect(
      buildRegistryModelSelectGroups("glm", view).find(
        (group) => group.key === "registry-provider:aggregator",
      )?.items[0],
    ).not.toHaveProperty("supportsVisionInput");
  });
  it("直接把 Registry API Provider 投影为有序模型组", () => {
    const selectionView: ModelSelectionView = {
      revision: 7,
      providers: [
        {
          providerId: "anthropic-api",
          providerName: "Anthropic API",
          config: {
            access: { type: "api-key", apiKey: "secret" },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://example.com/anthropic",
            },
            models: ["claude-a", "claude-b"],
          },
          models: [
            {
              modelId: "claude-a",
              config: { properties: { inputFormat: { supportsImage: true } } },
            },
            { modelId: "claude-b", config: {} },
          ],
        },
        {
          providerId: "openai-api",
          providerName: "OpenAI API",
          config: {
            access: { type: "api-key", apiKey: "secret" },
            api: {
              type: "openai-responses",
              baseUrl: "https://example.com/openai",
            },
            models: ["model-a"],
          },
          models: [{ modelId: "model-a", config: {} }],
        },
      ],
    };

    expect(buildRegistryModelSelectGroups("glm", selectionView)).toEqual([
      { key: "application-models:system", label: "System models", directItems: true, items: [] },
      { key: "application-models:personal", label: "Custom models", directItems: true, items: [] },
      {
        key: "registry-provider:anthropic-api",
        label: "Anthropic API",
        labelBadge: "API",
        items: [
          {
            key: "registry-provider:anthropic-api:claude-a",
            value: "custom:anthropic-api:claude-a",
            name: "claude-a",
            supportsVisionInput: true,
          },
          {
            key: "registry-provider:anthropic-api:claude-b",
            value: "custom:anthropic-api:claude-b",
            name: "claude-b",
          },
        ],
      },
      {
        key: "registry-provider:openai-api",
        label: "OpenAI API",
        labelBadge: "API",
        items: [
          {
            key: "registry-provider:openai-api:model-a",
            value: "custom:openai-api:model-a",
            name: "model-a",
          },
        ],
      },
    ]);
  });

  it("直接把 Registry Account Provider 投影为已选连接，不重新裁决 Family", () => {
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
    const selectionView: ModelSelectionView = {
      revision: 8,
      providers: [
        {
          providerId,
          providerName: "BigModel Coding Plan",
          config: {
            access: {
              type: "zhipu-account",
              accountType: "bigmodel",
              mode: "team-coding-plan",
              entitled: true,
            },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://example.com/anthropic",
            },
            models: ["GLM-5.2"],
          },
          models: [{ modelId: "GLM-5.2", config: {} }],
        },
      ],
    };

    expect(buildRegistryModelSelectGroups("glm", selectionView)).toEqual([
      { key: "application-models:system", label: "System models", directItems: true, items: [] },
      { key: "application-models:personal", label: "Custom models", directItems: true, items: [] },
      {
        key: `registry-provider:${providerId}`,
        label: "BigModel",
        labelBadge: "Team",
        directItems: true,
        items: [
          {
            key: `registry-provider:${providerId}:GLM-5.2`,
            value: "custom:account%3Abigmodel-team-coding-plan:GLM-5.2",
            name: "GLM-5.2",
          },
        ],
      },
    ]);
  });
});

it("native assembly retains provider groups without application partitions", () => {
  expect(buildNativeModelGroups("glm", { revision: 1, providers: [] })).toEqual([]);
});
