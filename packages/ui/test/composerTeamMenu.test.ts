// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ApplicationSettingsProvider, useApplicationSettings } from "@/root/ApplicationSettings.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import type { ComposerPlanGroup } from "@/lib/composerPlanGroups.js";
const items = [{ key: "m", value: "team/model", name: "GLM-5.3" }];
const groups: ComposerPlanGroup[] = [
  {
    key: "personal",
    label: "BigModel",
    labelBadge: "Individual",
    items: [{ ...items[0]!, value: "personal/model" }],
  },
  { key: "one", label: "BigModel", labelBadge: "Team One", items },
  { key: "two", label: "BigModel", labelBadge: "Team Two", items },
  {
    key: "api",
    label: "DeepSeek",
    labelBadge: "API",
    items: [{ key: "api", value: "api/model", name: "API model" }],
  },
];
function Harness({ pending = false, error = null }: { pending?: boolean; error?: string | null }) {
  const [selected, setSelected] = useState("personal");
  const [model, setModel] = useState("personal/model");
  return createElement(
    ZCodeIntlProvider,
    { locale: "en-US" },
    createElement(
      TooltipProvider,
      null,
      createElement(ModelConfigSelect, {
        modelGroups: groups,
        normalizedValue: model,
        triggerLabel: "GLM-5.3",
        tooltipTitle: "GLM-5.3",
        lockReasonMessage: "",
        isItemLocked: () => false,
        onValueChange: setModel,
        open: true,
        onOpenChange: () => {},
        focusSelectorOnClose: null,
        composerOptions: {
          providerLabel: "Provider",
          modelsLabel: "Models",
          effortLabel: "Effort",
          selectModelLabel: "Select model",
          levels: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
          value: "low",
          onValueChange: () => {},
          providerMenu: {
            groups,
            selectedKey: selected,
            pending,
            error,
            onSelect: (g) => {
              setSelected(g.key);
              setModel(g.items[0]!.value);
            },
          },
        },
      }),
    ),
  );
}
beforeEach(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(cleanup);
describe("Composer direct team provider menu", () => {
  it("保持主菜单一行供应商，直接选择第二团队时勾选不落到同模型的第一团队", async () => {
    render(createElement(Harness));
    expect(screen.queryByTestId("composer-connection-trigger")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "BigModel Team Two" }));
    await waitFor(() =>
      expect(screen.getByTestId("composer-provider-trigger").textContent).toContain("Team Two"),
    );
    fireEvent.keyDown(screen.getByTestId("composer-provider-trigger"), { key: "ArrowRight" });
    expect(
      (await screen.findByRole("menuitemradio", { name: "BigModel Team Two" })).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(
      screen.getByRole("menuitemradio", { name: "BigModel Team One" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByRole("menuitemradio", { name: "DeepSeek API" })).toBeTruthy();
  });
  it.each([false, true])(
    "切换 loading 有明确反馈且不替换原名称，失败结束后可重试（窄屏=%s）",
    async (narrow) => {
      window.matchMedia = vi.fn().mockReturnValue({
        matches: narrow,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      const { rerender } = render(createElement(Harness, { pending: true }));
      const trigger = screen.getByTestId("composer-provider-trigger");
      expect(trigger.getAttribute("aria-disabled")).toBe("true");
      expect(trigger.getAttribute("aria-busy")).toBe("true");
      expect(trigger.textContent).toContain("Individual");
      expect(screen.getByRole("status", { name: "Loading..." })).toBeTruthy();
      expect(screen.getByRole("slider").getAttribute("aria-disabled")).toBe("true");
      rerender(createElement(Harness, { error: "Switch failed; retry" }));
      expect(screen.queryByRole("status", { name: "Loading..." })).toBeNull();
      if (narrow) expect(screen.getByTestId("composer-provider-back")).toBeTruthy();
      else {
        expect(screen.getByTestId("composer-provider-trigger")).toBe(trigger);
        expect(trigger.getAttribute("aria-disabled")).not.toBe("true");
      }
      expect((await screen.findByRole("alert")).textContent).toContain("retry");
      expect(
        screen.getByRole("alert").parentElement?.querySelector("[data-composer-provider-list]"),
      ).toBeTruthy();
    },
  );
  it("窄屏使用现有返回导航，选团队后回到模型页", async () => {
    window.matchMedia = vi
      .fn()
      .mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    render(createElement(Harness));
    fireEvent.click(screen.getByTestId("composer-provider-trigger"));
    expect(screen.getByTestId("composer-provider-back")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "BigModel Team One" }));
    await waitFor(() =>
      expect(screen.getByTestId("composer-provider-trigger").textContent).toContain("Team One"),
    );
    expect(screen.queryByTestId("composer-provider-back")).toBeNull();
    expect(screen.getByRole("slider")).toBeTruthy();
  });
});

it("连接 loading 期间固定原菜单展示，完成后一次采用新目录", () => {
  const content = (pending: boolean, target: boolean) =>
    createElement(
      ZCodeIntlProvider,
      { locale: "en-US" },
      createElement(
        TooltipProvider,
        null,
        createElement(ModelConfigSelect, {
          modelGroups: target ? [groups[3]!] : groups,
          normalizedValue: target ? "api/model" : "personal/model",
          triggerLabel: target ? "API model" : "GLM-5.3",
          lockReasonMessage: "",
          isItemLocked: () => false,
          onValueChange: () => {},
          open: true,
          onOpenChange: () => {},
          composerOptions: {
            providerLabel: "Provider",
            modelsLabel: "Models",
            effortLabel: "Effort",
            selectModelLabel: "Select model",
            levels: target
              ? []
              : [
                  { value: "low", label: "Low" },
                  { value: "high", label: "High" },
                ],
            value: target ? "" : "low",
            onValueChange: () => {},
            providerMenu: {
              groups: target ? [groups[3]!] : groups,
              selectedKey: target ? "api" : "personal",
              pending,
              error: null,
              onSelect: () => {},
            },
          },
        }),
      ),
    );
  const ui = render(content(false, false));
  expect(screen.getByTestId("composer-thought-slider").getAttribute("aria-valuetext")).toBe("Low");
  ui.rerender(content(true, true));
  expect(screen.getByTestId("composer-thought-slider").getAttribute("aria-valuetext")).toBe("Low");
  expect(screen.getByTestId("composer-provider-trigger").textContent).toContain("Individual");
  ui.rerender(content(false, true));
  expect(screen.queryByTestId("composer-thought-slider")).toBeNull();
  expect(screen.getByTestId("composer-provider-trigger").textContent).toContain("DeepSeek");
});

// 使用真实应用分区投影，防止普通 Provider 测试掩盖聚合分组误入连接切换。
function ApplicationGroupsHarness({
  custom = false,
  locale = "en-US",
  onConnection = () => {},
  onManageModels = () => {},
  locked = false,
  externalValue,
}: {
  custom?: boolean;
  locale?: "en-US" | "zh-CN";
  onConnection?: () => void;
  onManageModels?: () => void;
  locked?: boolean;
  externalValue?: string;
}) {
  const grouped = buildRegistryModelSelectGroups(
    "glm",
    {
      revision: 1,
      providers: [
        {
          providerId: "application:fixture",
          config: { group: "application-managed", api: { type: "openai-chat-completions" } },
          models: [{ modelId: "same/name", config: {} }],
        },
        ...(custom
          ? [
              {
                providerId: "personal-fixture",
                providerName: "My API",
                config: {
                  group: "standard-personal" as const,
                  api: { type: "openai-chat-completions" as const },
                },
                models: [{ modelId: "same/name", config: {} }],
              },
            ]
          : []),
      ],
    },
    { applicationGrouping: true },
  );
  const [value, setValue] = useState(grouped[0]!.items[0]!.value);
  const [open, setOpen] = useState(true);
  const currentValue = externalValue ?? value;
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: locale },
    createElement(
      TooltipProvider,
      null,
      createElement(ModelConfigSelect, {
        modelGroups: grouped,
        normalizedValue: currentValue,
        triggerLabel: "same/name",
        open,
        onOpenChange: setOpen,
        showManageModelsAction: true,
        manageModelsLabel: "Manage models",
        onManageModels,
        lockReasonMessage: "Locked",
        isItemLocked: (candidate) => locked && candidate === grouped[1]!.items[0]?.value,
        onValueChange: setValue,
        focusSelectorOnClose: null,
        composerOptions: {
          providerLabel: "Provider",
          modelsLabel: "Models",
          effortLabel: "Effort",
          selectModelLabel: "Select model",
          levels: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" },
          ],
          value: "low",
          onValueChange: () => {},
          providerMenu: {
            groups: grouped,
            selectedKey: grouped.find((g) => g.items.some((i) => i.value === currentValue))?.key,
            pending: false,
            error: null,
            onSelect: onConnection,
          },
        },
      }),
      createElement("output", { "data-testid": "actual-model" }, currentValue),
    ),
  );
}
function openApplicationGroups(narrow: boolean) {
  const trigger = screen.getByTestId("composer-provider-trigger");
  if (narrow) fireEvent.click(trigger);
  else fireEvent.keyDown(trigger, { key: "ArrowRight" });
}
describe("application model sections in the combined menu", () => {
  it.each([false, true])(
    "空自定义分区原位显示空态，保持当前模型且不触发连接（窄屏=%s）",
    async (narrow) => {
      window.matchMedia = vi
        .fn()
        .mockReturnValue({ matches: narrow, addEventListener() {}, removeEventListener() {} });
      const connection = vi.fn(),
        manage = vi.fn();
      render(
        createElement(ApplicationGroupsHarness, {
          onConnection: connection,
          onManageModels: manage,
        }),
      );
      const current = screen.getByTestId("actual-model").textContent;
      openApplicationGroups(narrow);
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Custom models" }));
      await screen.findByText("No custom models yet");
      expect(screen.getByTestId("composer-provider-trigger").textContent).toContain(
        "Custom models",
      );
      expect(screen.queryByRole("slider")).toBeNull();
      expect(screen.getByTestId("actual-model").textContent).toBe(current);
      expect(connection).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("menuitem", { name: "Add custom model" }));
      expect(manage).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).toBeNull();
    },
  );
  it.each([false, true])(
    "浏览非空分区不自动选模，明确点型号保留精确身份并可返回系统（窄屏=%s）",
    async (narrow) => {
      window.matchMedia = vi
        .fn()
        .mockReturnValue({ matches: narrow, addEventListener() {}, removeEventListener() {} });
      const connection = vi.fn();
      render(createElement(ApplicationGroupsHarness, { custom: true, onConnection: connection }));
      const systemValue = screen.getByTestId("actual-model").textContent;
      openApplicationGroups(narrow);
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Custom models" }));
      await waitFor(() =>
        expect(screen.getByTestId("composer-provider-trigger").textContent).toContain(
          "Custom models",
        ),
      );
      expect(screen.getByTestId("actual-model").textContent).toBe(systemValue);
      fireEvent.click(screen.getByRole("menuitemradio", { name: /same\/name.*My API/ }));
      expect(screen.getByTestId("actual-model").textContent).toBe(
        "custom:personal-fixture:same%2Fname",
      );
      expect(screen.getByRole("slider").getAttribute("aria-disabled")).toBe("false");
      openApplicationGroups(narrow);
      fireEvent.click(screen.getByRole("menuitemradio", { name: "System models" }));
      expect(screen.getByTestId("actual-model").textContent).toBe(
        "custom:personal-fixture:same%2Fname",
      );
      fireEvent.click(screen.getByRole("menuitemradio", { name: "same/name", exact: true }));
      expect(screen.getByTestId("actual-model").textContent).toBe(systemValue);
      expect(connection).not.toHaveBeenCalled();
    },
  );
  it("浏览分区不绕过型号锁定；再次打开定位真实当前模型", async () => {
    render(createElement(ApplicationGroupsHarness, { custom: true, locked: true }));
    const initial = screen.getByTestId("actual-model").textContent;
    openApplicationGroups(false);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Custom models" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /same\/name.*My API/ }));
    expect(screen.getByTestId("actual-model").textContent).toBe(initial);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.keyDown(screen.getByTestId("chat-model-select-trigger"), { key: "Enter" });
    expect((await screen.findByTestId("composer-provider-trigger")).textContent).toContain(
      "System models",
    );
  });
  it("浏览期间自定义目录晚到，只更新列表，不自动更改模型", async () => {
    const connection = vi.fn();
    const view = render(createElement(ApplicationGroupsHarness, { onConnection: connection }));
    const initial = screen.getByTestId("actual-model").textContent;
    openApplicationGroups(false);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Custom models" }));
    await screen.findByText("No custom models yet");
    view.rerender(
      createElement(ApplicationGroupsHarness, { custom: true, onConnection: connection }),
    );
    expect(screen.queryByText("No custom models yet")).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: /same\/name.*My API/ })).toBeTruthy();
    expect(screen.getByTestId("actual-model").textContent).toBe(initial);
    expect(connection).not.toHaveBeenCalled();
  });
  it("外部模型改变废弃旧浏览意图，切回原型号也不复活旧分组", () => {
    const system = "custom:application%3Afixture:same%2Fname";
    const personal = "custom:personal-fixture:same%2Fname";
    const view = render(
      createElement(ApplicationGroupsHarness, { custom: true, externalValue: system }),
    );
    openApplicationGroups(false);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Custom models" }));
    view.rerender(
      createElement(ApplicationGroupsHarness, { custom: true, externalValue: personal }),
    );
    expect(screen.getByTestId("composer-provider-trigger").textContent).toContain("Custom models");
    view.rerender(createElement(ApplicationGroupsHarness, { custom: true, externalValue: system }));
    expect(screen.getByTestId("composer-provider-trigger").textContent).toContain("System models");
  });
  it("合并菜单的分区、空态与配置入口使用中文", async () => {
    render(createElement(ApplicationGroupsHarness, { locale: "zh-CN" }));
    expect(screen.getByTestId("composer-provider-trigger").textContent).toContain("系统模型");
    openApplicationGroups(false);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "自定义模型" }));
    await screen.findByText("尚未添加自定义模型");
    expect(screen.getByRole("menuitem", { name: "添加自定义模型" })).toBeTruthy();
  });
});

it("添加自定义模型准确导航已有自定义 Tab，不落到默认应用模型页", () => {
  function TabProbe() {
    return createElement(
      "output",
      { "data-testid": "settings-entry" },
      useApplicationSettings()?.modelEntry?.id ?? "custom",
    );
  }
  const manage = vi.fn();
  render(
    createElement(
      ApplicationSettingsProvider,
      {
        settings: {
          modelEntries: [{ id: "managed", label: "Managed", Icon: () => null, render: () => null }],
        },
      },
      createElement(ApplicationGroupsHarness, { onManageModels: manage }),
      createElement(TabProbe),
    ),
  );
  expect(screen.getByTestId("settings-entry").textContent).toBe("managed");
  openApplicationGroups(false);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Custom models" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Add custom model" }));
  expect(screen.getByTestId("settings-entry").textContent).toBe("custom");
  expect(manage).toHaveBeenCalledOnce();
});
