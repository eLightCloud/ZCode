// @vitest-environment jsdom
import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Package } from "lucide-react";
import {
  ApplicationSettingsProvider,
  ApplicationSettingsContent,
  useApplicationSettings,
  type ApplicationSettings,
} from "@/root/ApplicationSettings.js";
import { ModelProviderSectionLayout } from "@/settings/model-provider-section/SectionLayout.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { act } from "@testing-library/react";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/settings/model-provider-section/Navigation.js", () => ({
  ModelProviderSectionNavigation: ({
    onSelectNavItem,
  }: {
    onSelectNavItem: (item: unknown) => void;
  }) => h("button", { onClick: () => onSelectNavItem({ key: "custom" }) }, "existing provider"),
}));
afterEach(cleanup);
const settings: ApplicationSettings = {
  sections: [
    {
      id: "account",
      label: "Account",
      group: "basics",
      Icon: Package,
      render: ({ openModelEntry }) =>
        h("button", { onClick: () => openModelEntry("managed") }, "member budget"),
    },
  ],
  modelEntries: [
    {
      id: "managed",
      label: "Managed models",
      Icon: Package,
      render: () => h("p", null, "managed budget"),
    },
  ],
};
function Probe() {
  const context = useApplicationSettings();
  return h(
    "div",
    null,
    h("button", { onClick: () => context?.selectSection("account") }, "account"),
    h("button", { onClick: () => context?.selectSection(null) }, "native section"),
    h("output", null, context?.section?.label ?? "native"),
    h(ApplicationSettingsContent),
    h(ModelProviderSectionLayout, {
      description: "Model configuration",
      refreshLabel: "refresh",
      loadingLabel: "loading",
      presetLoading: false,
      customLoading: false,
      onRefresh: vi.fn(),
      addProviderLabel: "add provider",
      onAddProvider: vi.fn(),
      navigationGroups: [],
      selectedNodeKey: "custom",
      onSelectNavItem: vi.fn(),
      children: h("p", null, "existing API configuration"),
    }),
  );
}
function element(config?: ApplicationSettings) {
  return h(ZCodeIntlProvider, {
    initialLocale: "en-US",
    children: h(ApplicationSettingsProvider, { settings: config, children: h(Probe) }),
  });
}
it("leaves native provider content intact when no extension is configured", () => {
  render(element());
  expect(screen.getByText("existing API configuration")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Managed models" })).toBeNull();
});
it("reuses the provider panel and switches from injected content to existing API configuration", () => {
  render(element(settings));
  expect(screen.getByText("managed budget")).toBeTruthy();
  expect(screen.queryByText("existing API configuration")).toBeNull();
  fireEvent.click(screen.getByText("existing provider"));
  expect(screen.getByText("existing API configuration")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Managed models" }));
  expect(screen.getByText("managed budget")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "add provider" }));
  expect(screen.getByText("existing API configuration")).toBeTruthy();
});
it("supports precise member-to-model navigation and drops removed content", () => {
  const view = render(element(settings));
  fireEvent.click(screen.getByText("account"));
  expect(screen.getByText("Account")).toBeTruthy();
  fireEvent.click(screen.getByText("member budget"));
  expect(screen.getByText("native")).toBeTruthy();
  expect(screen.getByText("managed budget")).toBeTruthy();
  fireEvent.click(screen.getByText("account"));
  view.rerender(element({ sections: [], modelEntries: [] }));
  expect(screen.queryByText("member budget")).toBeNull();
  expect(screen.queryByText("managed budget")).toBeNull();
  expect(screen.getByText("existing API configuration")).toBeTruthy();
});
it("honors native settings intents while the application section remains selected", () => {
  render(element(settings));
  fireEvent.click(screen.getByText("account"));
  expect(screen.getByText("member budget")).toBeTruthy();
  act(() => setPendingSettingsSectionIntent("modelProvider", { modelProviderId: "custom" }));
  expect(screen.queryByText("member budget")).toBeNull();
  expect(screen.getByText("existing API configuration")).toBeTruthy();
});
