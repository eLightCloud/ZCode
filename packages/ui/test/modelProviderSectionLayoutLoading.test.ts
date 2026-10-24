import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactNode } from "react";

import { describe, expect, it, vi } from "vitest";
import {
  ModelProviderSectionLayout,
  shouldShowModelProviderRefreshLoading,
} from "@/settings/model-provider-section/SectionLayout.js";

vi.mock("@/settings/model-provider-section/Navigation.js", () => ({
  ModelProviderSectionNavigation: () => createElement("nav", null, "providers"),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

describe("model provider section refresh button loading", () => {
  it("preset 或 custom 分组加载中时，刷新按钮应显示 loading", () => {
    expect(
      shouldShowModelProviderRefreshLoading({
        presetLoading: true,
        customLoading: false,
      }),
    ).toBe(true);

    expect(
      shouldShowModelProviderRefreshLoading({
        presetLoading: false,
        customLoading: true,
      }),
    ).toBe(true);
  });

  it("全部分组都不在加载时，刷新按钮不显示 loading", () => {
    expect(
      shouldShowModelProviderRefreshLoading({
        presetLoading: false,
        customLoading: false,
      }),
    ).toBe(false);
  });

  it("没有供应商时不显示空侧栏或固定高度，仍保留原生配置操作", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          ModelProviderSectionLayout,
          {
            description: "description",
            refreshLabel: "refresh",
            loadingLabel: "loading",
            presetLoading: false,
            customLoading: false,
            onRefresh: vi.fn(),
            addProviderLabel: "add provider",
            onAddProvider: vi.fn(),
            navigationGroups: [],
            selectedNodeKey: null,
            onSelectNavItem: vi.fn(),
          },
          createElement("div", null, "detail"),
        ),
      ),
    );

    expect(html).not.toContain('data-model-provider-split-panel="true"');
    expect(html).toContain('aria-label="add provider"');
    const refreshButtonIndex = html.indexOf('aria-label="refresh"');
    const addProviderButtonIndex = html.indexOf('aria-label="add provider"');
    expect(refreshButtonIndex).toBeGreaterThan(-1);
    expect(refreshButtonIndex).toBeLessThan(addProviderButtonIndex);
    const addProviderButton =
      html.slice(0, addProviderButtonIndex).match(/<button[^>]*$/)?.[0] ?? "";
    expect(addProviderButton).toContain('data-variant="default"');
    expect(addProviderButton).toContain('data-size="default"');
    expect(html).not.toContain("min-h-[36rem]");
    expect(html).toContain("overflow-clip");
    expect(html).not.toContain('data-model-provider-navigation-scroll="true"');
    expect(html).toContain('data-model-provider-detail-scroll="true"');
    expect(html).not.toContain("data-scroll-edge-shadow");
    expect(html).not.toContain("overflow-y-auto");
    expect(html).not.toContain("overscroll-contain");
  });
});
