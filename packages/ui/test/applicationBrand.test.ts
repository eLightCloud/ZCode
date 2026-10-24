// @vitest-environment jsdom
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ApplicationBrandProvider,
  ApplicationBrandImage,
  formatApplicationBrandMessage,
} from "@/application-brand.js";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import zh from "@/i18n/locales/zh-CN.js";
import en from "@/i18n/locales/en-US.js";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";
const Mark = ({ className }: { className?: string }) =>
  createElement("svg", { className, "data-brand": "test-mark" });
const brand = { name: "Example Application", Mark, Wordmark: Mark };
describe("application branding boundary", () => {
  it("keeps unconfigured native artwork and titles", () => {
    expect(renderToStaticMarkup(createElement(ZCodeAboutLogo))).toContain('viewBox="0 0 256 218"');
    expect(formatApplicationBrandMessage(undefined, "login.title", "Welcome to ZCode")).toBe(
      "Welcome to ZCode",
    );
  });
  it("substitutes product artwork including collapsed image consumers", () => {
    const html = renderToStaticMarkup(
      createElement(ApplicationBrandProvider, {
        brand,
        children: [
          createElement(ZCodeAboutLogo, { key: "logo" }),
          createElement(ApplicationBrandImage, {
            key: "image",
            src: "/native.svg",
            alt: "ZCode",
          }),
        ],
      }),
    );
    expect(html).toContain('data-brand="test-mark"');
    expect(html).toContain('aria-label="Example Application"');
    expect(html).not.toContain("/native.svg");
  });
  it("brands app titles while preserving actual provider and runtime identities", () => {
    expect(formatApplicationBrandMessage(brand.name, "application.name", "ZCode")).toBe(brand.name);
    expect(
      formatApplicationBrandMessage(brand.name, "titleBar.menu.help.about", "About ZCode"),
    ).toBe("About Example Application");
    expect(
      formatApplicationBrandMessage(brand.name, "settings.mcp.description", "ZCode Agent MCP"),
    ).toBe("Native Agent MCP");
  });
  it("substitutes everyday product copy and preserves mixed runtime labels", () => {
    for (const messages of [zh, en]) {
      for (const id of [
        "chat.placeholder.newTask",
        "onboarding.dialog.title",
        "settings.plugins.import.mode.copy.description",
        "offPeak.keepAwakeBanner",
        "cuaPermission.modal.relaunchAppButton",
        "bots.description",
      ]) {
        expect(formatApplicationBrandMessage(brand.name, id, messages[id])).toContain(brand.name);
      }
    }
    expect(
      formatApplicationBrandMessage(
        brand.name,
        "settings.mcp.refresh",
        "ZCode Agent needs a refresh. Restart ZCode.",
      ),
    ).toBe("Native Agent needs a refresh. Restart Example Application.");
    expect(formatApplicationBrandMessage(brand.name, "source", "ZCode MCP / ZCode CDN")).toBe(
      "Tool Service / ZCode CDN",
    );
  });
  it("exposes the localized brand to Intl when the shell wraps the entire tree", () => {
    function Copy() {
      const { intl } = useZCodeIntl();
      return createElement("p", null, intl.formatMessage({ id: "chat.placeholder.newTask" }));
    }
    const html = renderToStaticMarkup(
      createElement(ApplicationBrandProvider, {
        brand: { ...brand, localizedNames: { "zh-CN": "示例产品" } },
        children: createElement(ZCodeIntlProvider, {
          initialLocale: "zh-CN",
          children: createElement(Copy),
        }),
      }),
    );
    expect(html).toContain("示例产品");
    expect(html).not.toContain("ZCode");
  });
});

it("localizes application navigation without renaming native sources", () => {
  function Copy() {
    const { intl } = useZCodeIntl();
    return createElement(
      "p",
      null,
      intl.formatMessage({ id: "workspace.openPluginsSettings" }),
      " / ",
      intl.formatMessage({ id: "settings.plugins.marketplaces.title" }),
    );
  }
  const native = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(Copy),
    }),
  );
  expect(native).toContain("插件市场 / 插件市场");
  const configured = renderToStaticMarkup(
    createElement(ApplicationBrandProvider, {
      brand: {
        ...brand,
        localizedMessages: {
          "zh-CN": { "workspace.openPluginsSettings": "企业场景" },
        },
      },
      children: createElement(ZCodeIntlProvider, {
        initialLocale: "zh-CN",
        children: createElement(Copy),
      }),
    }),
  );
  expect(configured).toContain("企业场景 / 插件市场");
});
