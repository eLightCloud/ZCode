// @vitest-environment jsdom
import { createElement as h } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) => children,
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
      render: () => h("input", { "aria-label": "managed draft", defaultValue: "original" }),
    },
    {
      id: "personal",
      label: "Personal models",
      Icon: Package,
      render: ({ openCustomModels }) =>
        h("button", { onClick: openCustomModels }, "Configure custom"),
    },
  ],
};
function Probe() {
  const context = useApplicationSettings();
  return h(
    "div",
    null,
    h("button", { onClick: () => context?.selectSection("account") }, "account"),
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
      children: h("input", {
        "aria-label": "native provider draft",
        defaultValue: "native original",
      }),
    }),
  );
}
function element(config?: ApplicationSettings) {
  return h(ZCodeIntlProvider, {
    initialLocale: "en-US",
    children: h(ApplicationSettingsProvider, { settings: config, children: h(Probe) }),
  });
}
function tab(name: string | RegExp) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0, ctrlKey: false });
}

it("leaves native configuration unchanged without application entries", () => {
  render(element());
  expect(screen.getByRole("textbox", { name: "native provider draft" })).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.getByRole("button", { name: "add provider" })).toBeTruthy();
});
it("separates model sources with accessible tabs and exposes provider controls only on custom", () => {
  render(element(settings));
  expect(screen.getAllByRole("tab")).toHaveLength(3);
  expect(screen.getByRole("tab", { name: "Managed models" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
    screen.getByRole("tab", { name: "Managed models" }).id,
  );
  expect(screen.queryByRole("button", { name: "add provider" })).toBeNull();
  expect(screen.queryByText("Configure custom")).toBeNull();
  tab(/custom models/i);
  expect(screen.getByRole("button", { name: "add provider" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "managed draft" })).toBeNull();
});
it("retains both application and native unsaved inputs across tab changes", () => {
  render(element(settings));
  fireEvent.change(screen.getByRole("textbox", { name: "managed draft" }), {
    target: { value: "unsaved quota" },
  });
  tab(/custom models/i);
  fireEvent.change(screen.getByRole("textbox", { name: "native provider draft" }), {
    target: { value: "unsaved provider" },
  });
  tab("Managed models");
  expect((screen.getByRole("textbox", { name: "managed draft" }) as HTMLInputElement).value).toBe(
    "unsaved quota",
  );
  tab(/custom models/i);
  expect(
    (screen.getByRole("textbox", { name: "native provider draft" }) as HTMLInputElement).value,
  ).toBe("unsaved provider");
});
it("lets a model panel navigate to real custom configuration and drops removed descriptors", () => {
  const view = render(element(settings));
  tab("Personal models");
  fireEvent.click(screen.getByRole("button", { name: "Configure custom" }));
  expect(screen.getByRole("textbox", { name: "native provider draft" })).toBeTruthy();
  view.rerender(element({ sections: [], modelEntries: [] }));
  expect(screen.queryByText("Configure custom")).toBeNull();
  expect(screen.queryByLabelText("managed draft")).toBeNull();
});
it("supports precise member navigation and native provider overrides", () => {
  render(element(settings));
  tab(/custom models/i);
  fireEvent.click(screen.getByRole("button", { name: "account" }));
  fireEvent.click(screen.getByRole("button", { name: "member budget" }));
  expect(screen.getByRole("textbox", { name: "managed draft" })).toBeTruthy();
  expect(screen.getByText("native")).toBeTruthy();
  act(() => setPendingSettingsSectionIntent("modelProvider", { modelProviderId: "custom" }));
  expect(screen.getByRole("textbox", { name: "native provider draft" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "managed draft" })).toBeNull();
});
it("changes the selected source through keyboard focus", () => {
  render(element(settings));
  act(() => screen.getByRole("tab", { name: "Personal models" }).focus());
  expect(screen.getByRole("tab", { name: "Personal models" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(screen.getByRole("button", { name: "Configure custom" })).toBeTruthy();
});
