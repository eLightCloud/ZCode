// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  PluginStoreListView,
  type PluginStoreSegment,
} from "@/settings/PluginStoreListView.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
vi.mock("@/hooks/useInterfaceMode.js", () => ({
  useIsOfficeMode: () => false,
}));
vi.mock("@/settings/PluginStoreAvatar.js", () => ({
  PluginStoreAvatar: () => null,
}));
vi.mock("@/settings/PluginStoreCard.js", () => ({
  PluginStoreCard: ({ item }: { item: StorePluginItem }) =>
    createElement("p", null, item.name),
}));
afterEach(cleanup);
const item = (name: string, marketplace: string, installed = false) =>
  ({
    id: name + "@" + marketplace,
    name,
    marketplace,
    installed,
    restorable: false,
  }) as StorePluginItem;
function element(segment: PluginStoreSegment, query = "", content?: ReactNode) {
  return createElement(ZCodeIntlProvider, {
    initialLocale: "zh-CN",
    children: createElement(TooltipProvider, {
      children: createElement(PluginStoreListView, {
        items: [
          item("native-personal", "personal-source"),
          item("tenant-scene", "tenant-source", true),
        ],
        marketplaces: [],
        actions: {
          onOpenDetail: vi.fn(),
          onInstall: vi.fn(),
          onUninstall: vi.fn(),
          onUpdate: vi.fn(),
          operationId: null,
          togglingPluginId: null,
        },
        loading: false,
        query,
        onQueryChange: vi.fn(),
        segment,
        onSegmentChange: vi.fn(),
        onOpenManage: vi.fn(),
        applicationSection: content
          ? { label: "企业", marketplaceIds: ["tenant-source"], content }
          : undefined,
      }),
    }),
  });
}
it("preserves the native two segments when there is no application catalog", () => {
  render(element("personal"));
  expect(
    screen.getByRole("button", { name: "公开", exact: true }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "个人", exact: true }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "企业", exact: true }),
  ).toBeNull();
  expect(screen.getByText("tenant-scene")).toBeTruthy();
});
it("adds the third segment and excludes application sources from personal discovery while retaining installed inventory", () => {
  render(
    element("personal", "", createElement("p", null, "enterprise-content")),
  );
  expect(
    screen.getByRole("button", { name: "企业", exact: true }),
  ).toBeTruthy();
  expect(screen.getByText("native-personal")).toBeTruthy();
  expect(screen.queryByText("tenant-scene")).toBeNull();
  expect(screen.getByRole("button", { name: "Tenant Scene" })).toBeTruthy();
});
it("keeps application results visible when its search query matches no native plugin", () => {
  render(
    element(
      "application",
      "tenant query",
      createElement("p", null, "authorized-result"),
    ),
  );
  expect(screen.getByText("authorized-result")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "企业", exact: true })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.queryByText("没有找到匹配的插件")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "公开", exact: true }));
});
