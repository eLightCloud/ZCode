import { describe, expect, it } from "vitest";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import {
  buildPluginStoreTryMention,
  buildPluginStoreTryPrompt,
} from "@/settings/pluginStoreTryPrompt.js";

function pluginItem(overrides: Partial<StorePluginItem> = {}): StorePluginItem {
  return {
    id: "demo-plugin@demo-market",
    name: "demo-plugin",
    marketplace: "demo-market",
    installed: true,
    restorable: false,
    orphaned: false,
    listing: {
      displayName: "Demo [Plugin]",
      displayNameI18n: { "zh-CN": "演示插件" },
      icon: "https://cdn.example.com/demo-plugin.png",
    },
    ...overrides,
  };
}

describe("Plugin Store try prompt", () => {
  it("prefills only the shared canonical Plugin reference for Try now", () => {
    expect(
      buildPluginStoreTryPrompt({
        item: pluginItem(),
        locale: "en-US",
        prompt: "",
      }),
    ).toBe("[@Demo \\[Plugin\\]](plugin://demo-plugin@demo-market)");
  });

  it("prefills the shared canonical Plugin reference before the example prompt", () => {
    expect(
      buildPluginStoreTryPrompt({
        item: pluginItem(),
        locale: "en-US",
        prompt: "  Summarize this workspace.  ",
      }),
    ).toBe("[@Demo \\[Plugin\\]](plugin://demo-plugin@demo-market) Summarize this workspace.");
  });

  it("uses the localized display label without changing the stable destination", () => {
    expect(
      buildPluginStoreTryPrompt({
        item: pluginItem(),
        locale: "zh-CN",
        prompt: "帮我检查配置",
      }),
    ).toBe("[@演示插件](plugin://demo-plugin@demo-market) 帮我检查配置");
  });

  it("builds the same structured Plugin mention used by the @ picker", () => {
    expect(
      buildPluginStoreTryMention({
        item: pluginItem(),
        locale: "zh-CN",
      }),
    ).toEqual({
      id: "plugin:demo-plugin@demo-market",
      category: "plugins",
      label: "演示插件",
      value: "demo-plugin@demo-market",
      markdown: "[@演示插件](plugin://demo-plugin@demo-market)",
      data: {
        pluginId: "demo-plugin@demo-market",
        icon: "https://cdn.example.com/demo-plugin.png",
      },
    });
  });
});

it("uses the application guide label for example prefills without changing plugin identity", () => {
  const item = pluginItem({ id: "zcode-guide@zcode-plugins-official", name: "zcode-guide" });
  const prefill = buildPluginStoreTryMention({
    item,
    locale: "zh-CN",
    displayName: "翼辉睿观 使用指南",
  });
  expect(prefill.label).toBe("翼辉睿观 使用指南");
  expect(prefill.value).toBe(item.id);
  expect(prefill.markdown).toBe(
    "[@翼辉睿观 使用指南](plugin://zcode-guide@zcode-plugins-official)",
  );
  expect(
    buildPluginStoreTryPrompt({
      item,
      locale: "zh-CN",
      prompt: "配置帮助",
      displayName: prefill.label,
    }),
  ).toBe(`${prefill.markdown} 配置帮助`);
});
