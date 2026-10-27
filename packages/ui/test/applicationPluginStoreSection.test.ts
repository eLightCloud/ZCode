// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PluginStoreListView, type PluginStoreSegment } from "@/settings/PluginStoreListView.js";
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
  PluginStoreCard: ({ item }: { item: StorePluginItem }) => createElement("p", null, item.name),
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
function element(
  segment: PluginStoreSegment,
  query = "",
  content?: ReactNode,
  options?: Partial<NonNullable<ComponentProps<typeof PluginStoreListView>["applicationSection"]>>,
) {
  return createElement(ZCodeIntlProvider, {
    initialLocale: "zh-CN",
    children: createElement(TooltipProvider, {
      children: createElement(PluginStoreListView, {
        items: [
          item("native-personal", "personal-source"),
          item("tenant-scene", "tenant-source", true),
          ...(options
            ? [
                item("managed-private", "vantage-hosted-test"),
                item("public-extra", "public-extra-source"),
              ]
            : []),
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
          ? { label: "企业", marketplaceIds: ["tenant-source"], content, ...options }
          : undefined,
      }),
    }),
  });
}
it("preserves the native two segments when there is no application catalog", () => {
  render(element("personal"));
  expect(screen.getByRole("button", { name: "公开", exact: true })).toBeTruthy();
  expect(screen.getByRole("button", { name: "个人", exact: true })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "企业", exact: true })).toBeNull();
  expect(screen.getByText("tenant-scene")).toBeTruthy();
});
it("adds the application segment and excludes managed sources from personal discovery, including installed entries", () => {
  render(element("personal", "", createElement("p", null, "enterprise-content")));
  expect(screen.getByRole("button", { name: "企业", exact: true })).toBeTruthy();
  expect(screen.getByText("native-personal")).toBeTruthy();
  expect(screen.queryByText("tenant-scene")).toBeNull();
  expect(screen.queryByRole("button", { name: "Tenant Scene" })).toBeNull();
});
it("keeps application results visible when its search query matches no native plugin", () => {
  render(element("application", "tenant query", createElement("p", null, "authorized-result")));
  expect(screen.getByText("authorized-result")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "企业", exact: true }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.queryByText("没有找到匹配的插件")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "公开", exact: true }));
});
it("renders authorized public projection alongside build-owned public sources", () => {
  render(
    element("public", "", createElement("p", null, "tenant-only"), {
      publicMarketplaceIds: ["public-extra-source"],
      publicContent: createElement("p", null, "public-authorized"),
      personalContent: createElement("p", null, "personal-authorized"),
      managedMarketplacePrefix: "vantage-hosted-",
    }),
  );
  expect(screen.getByText("public-authorized")).toBeTruthy();
  expect(screen.getByText("public-extra")).toBeTruthy();
  expect(screen.queryByText("personal-authorized")).toBeNull();
  expect(screen.queryByText("managed-private")).toBeNull();
});
it("excludes managed and public sources from personal discovery while rendering its authorized projection", () => {
  render(
    element("personal", "", createElement("p", null, "tenant-only"), {
      publicMarketplaceIds: ["public-extra-source"],
      personalContent: createElement("p", null, "personal-authorized"),
      managedMarketplacePrefix: "vantage-hosted-",
    }),
  );
  expect(screen.getByText("personal-authorized")).toBeTruthy();
  expect(screen.getByText("native-personal")).toBeTruthy();
  expect(screen.queryByText("public-extra")).toBeNull();
  expect(screen.queryByText("managed-private")).toBeNull();
  expect(screen.queryByRole("button", { name: "Tenant Scene" })).toBeNull();
});

it("hides the optional segment without losing personal catalog projection or source filtering", () => {
  render(
    element("personal", "", createElement("p", null, "tenant-only"), {
      visible: false,
      personalContent: createElement("p", null, "my-content"),
      managedMarketplacePrefix: "vantage-hosted-",
    }),
  );
  expect(screen.queryByRole("button", { name: "企业", exact: true })).toBeNull();
  expect(screen.getByText("my-content")).toBeTruthy();
  expect(screen.queryByText("tenant-scene")).toBeNull();
  expect(screen.queryByText("managed-private")).toBeNull();
});

it("never renders a hidden application segment while its old selection is being cleared", () => {
  render(element("application", "", createElement("p", null, "tenant-only"), { visible: false }));
  expect(screen.queryByText("tenant-only")).toBeNull();
});

it("renders authorized community cards without placing them in public", () => {
  const options = {
    communityContent: createElement("p", null, "approved-community"),
    counts: { community: 1, public: 1 },
    publicContent: createElement("p", null, "approved-public"),
  };
  const result = render(element("community", "", createElement("p", null, "tenant-only"), options));
  expect(screen.getByText("approved-community")).toBeTruthy();
  expect(screen.queryByTestId("plugin-store-community-empty")).toBeNull();
  expect(screen.queryByText("approved-public")).toBeNull();
  result.rerender(element("public", "", createElement("p", null, "tenant-only"), options));
  expect(screen.getByText("approved-public")).toBeTruthy();
  expect(screen.queryByText("approved-community")).toBeNull();
});
