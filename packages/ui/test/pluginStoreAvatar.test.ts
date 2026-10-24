import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginStoreAvatar } from "../src/settings/PluginStoreAvatar.js";
import { ApplicationBrandProvider } from "../src/application-brand.js";

describe("PluginStoreAvatar", () => {
  it.each([
    ["documents", "documents.png"],
    ["pdf", "pdf.png"],
    ["presentations", "presentations.png"],
    ["spreadsheets", "spreadsheets.png"],
    ["image-search", "image-search.png"],
  ])("uses bundled artwork for the official %s plugin", (name, assetName) => {
    const staleIcon = "https://cdn.example.com/old-document-skills.png";
    const render = (id: string) =>
      renderToStaticMarkup(
        createElement(PluginStoreAvatar, {
          item: { id, name, listing: { icon: staleIcon } },
        }),
      );

    expect(render(`${name}@zcode-plugins-official`)).toContain(assetName);
    expect(render(`${name}@zcode-plugins-official`)).not.toContain(staleIcon);
    expect(render(`${name}@personal`)).toContain(staleIcon);
  });

  it("uses the bundled creator artwork only for the official plugin, including stale listings", () => {
    const icon = "https://cdn.example.com/old-skill-creator.png";
    const render = (id: string) =>
      renderToStaticMarkup(
        createElement(PluginStoreAvatar, {
          item: { id, name: "plugin-creator", listing: { icon } },
        }),
      );
    expect(render("plugin-creator@zcode-plugins-official")).toContain("plugin-creator.png");
    expect(render("plugin-creator@zcode-plugins-official")).not.toContain(icon);
    expect(render("plugin-creator@personal")).toContain(icon);
  });

  it("keeps a trusted listing icon ahead of the fallback", () => {
    const html = renderToStaticMarkup(
      createElement(PluginStoreAvatar, {
        item: {
          name: "example-plugin",
          listing: { icon: "https://cdn.example.com/example.png" },
        },
        className: "size-10",
      }),
    );

    expect(html).toContain('src="https://cdn.example.com/example.png"');
    expect(html).not.toContain("lucide-blocks");
  });
});

it("preserves plugin artwork in a branded application", () => {
  const html = renderToStaticMarkup(
    createElement(ApplicationBrandProvider, {
      brand: {
        name: "Vantage",
        Mark: () => createElement("svg", { "data-product-mark": true }),
        Wordmark: () => null,
      },
      children: createElement(PluginStoreAvatar, {
        item: { id: "documents@zcode-plugins-official", name: "documents" },
      }),
    }),
  );
  expect(html).toContain("documents.png");
  expect(html).toContain("<img");
  expect(html).not.toContain("data-product-mark");
});

it("uses packaged originals for application builtin identities and known remote artwork", async () => {
  const { vi } = await import("vitest");
  vi.stubEnv("ZCODE_APPLICATION_PLUGIN_MARKETPLACE_ID", "vantage-native");
  vi.resetModules();
  try {
    const { resolvePluginIconSource } = await import("../src/lib/pluginIconSource.js");
    expect(resolvePluginIconSource("documents@vantage-native")).toContain("documents.png");
    expect(
      resolvePluginIconSource(
        "computer-use@vantage-native",
        "https://cdn-zcode.z.ai/zcode/official-plugin/assets/zcode-cua/icon.png",
      ),
    ).toContain("computer-use.png");
    expect(
      resolvePluginIconSource(
        undefined,
        "https://cdn-zcode.z.ai/zcode/official-plugin/assets/browser-use/icon.png",
      ),
    ).toContain("browser-use.png");
    expect(resolvePluginIconSource("documents@personal", "https://example.test/custom.png")).toBe(
      "https://example.test/custom.png",
    );
    expect(
      resolvePluginIconSource("documents@personal", "file:///private/icon.png"),
    ).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});
