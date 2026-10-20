// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useModelProviderNavigation } from "@/settings/model-provider-section/useModelProviderNavigation.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

function createCustomProvider(): ProviderSettingsFormProvider {
  return {
    providerId: "custom-provider",
    executable: true,
    enabled: true,
    hasPersonalConfig: true,
    personalConfig: { group: "standard-personal", personalModelIds: ["glm-5"] },
    config: {
      label: "Custom Provider",
      group: "standard-personal",
      access: { type: "api-key", apiKey: "sk-demo" },
      api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" },
      personalModelIds: ["glm-5"],
    },
    models: [{ modelId: "glm-5", config: {}, hasPersonalConfig: true }],
  };
}

function createIntl(messages: Record<string, string>) {
  return {
    formatMessage: ({ id }: { id: string }) => messages[id] ?? id,
  };
}

describe("model provider navigation i18n", () => {
  afterEach(cleanup);
  it("语言切换时刷新自定义供应商分组标题，添加入口不再混入导航", () => {
    const commonOptions = {
      presetProviders: [],
      modelProviders: [createCustomProvider()],
      codingPlanEntitlements: {},
      selectedNodeKey: null,
      setSelectedNodeKey: vi.fn(),
    };
    // 使用真实 React 生命周期，覆盖导航 hook 的可选应用上下文。
    const view = renderHook(({ intl }) => useModelProviderNavigation({ ...commonOptions, intl }), {
      initialProps: { intl: createIntl({ "settings.modelProvider.customTitle": "自定义供应商" }) },
    });
    expect(view.result.current.navigationGroups.find((group) => group.id === "custom")?.title).toBe(
      "自定义供应商",
    );
    view.rerender({
      intl: createIntl({ "settings.modelProvider.customTitle": "Custom Providers" }),
    });
    const group = view.result.current.navigationGroups.find((group) => group.id === "custom");
    expect(group?.title).toBe("Custom Providers");
    expect(group?.items).toHaveLength(1);
    expect(group?.items[0]?.type).toBe("custom");
  });
});
