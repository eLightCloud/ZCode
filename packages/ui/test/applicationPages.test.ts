// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ApplicationPages,
  ApplicationPageHeaderAction,
  ApplicationPageContent,
  type ApplicationPage,
} from "@/root/ApplicationPages.js";
import {
  ApplicationSettingsProvider,
  ApplicationSettingsContent,
} from "@/root/ApplicationSettings.js";
import { Package } from "lucide-react";
import { useApplicationPageNavigationState } from "@/root/ApplicationPageNavigation.js";
import { ApplicationPageIntentBridge } from "@/root/ApplicationPageIntent.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
const navigation = vi.hoisted(() => ({
  addTab: vi.fn(),
  openSettings: vi.fn(),
  setActiveTask: vi.fn(),
  local: vi.fn(async () => ({ workspacePath: "/synthetic-local" })),
  remote: vi.fn(async () => ({ workspacePath: "/synthetic-remote" })),
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (select: (state: unknown) => unknown) =>
    select({ tabs: [], openSettingsTab: navigation.openSettings }),
  useTabStoreApi: () => ({ getState: () => ({ addTab: navigation.addTab }) }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ projectService: { prepareSession: navigation.local } }),
  useWorkspaceServicesResolution: () => ({
    services: { projectService: { prepareSession: navigation.remote } },
    rpcReady: false,
  }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (select: (state: unknown) => unknown) =>
    select({ setActiveTaskId: navigation.setActiveTask }),
}));
vi.mock("@/DesktopOverlayWindowControls.js", () => ({
  DesktopOverlayWindowControls: () => null,
}));
afterEach(cleanup);
function element(pages: ApplicationPage[], headerPageId?: string) {
  return createElement(ZCodeIntlProvider, {
    initialLocale: "zh-CN",
    children: createElement(TooltipProvider, {
      children: createElement(ApplicationPages, {
        pages,
        headerPageId,
        children: createElement(ApplicationPageHeaderAction),
      }),
    }),
  });
}
describe("trusted application page lifecycle", () => {
  it("opens a compact application dialog without full-page controls and restores draft and focus", async () => {
    const pages: ApplicationPage[] = [{
      id: "compact", label: "Compact", standalone: true, presentation: "dialog",
      render: () => createElement("p", null, "compact content"),
    }];
    render(createElement("div", null,
      createElement("input", { "aria-label": "draft", defaultValue: "unsent" }),
      element(pages, "compact"),
    ));
    const trigger = screen.getByRole("button", { name: "Compact" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Compact" })).toBeTruthy();
    expect(screen.getByText("compact content")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "刷新页面" })).toBeNull();
    expect(screen.queryByRole("button", { name: "返回工作台" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("unsent");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("opens a local continuation through the base Host even when a remote workspace is active", async () => {
    navigation.local.mockClear();
    navigation.remote.mockClear();
    const pages: ApplicationPage[] = [
      {
        id: "history",
        label: "History",
        standalone: true,
        render: (context) =>
          createElement(
            "button",
            { onClick: () => void context.openConversation?.("same-session") },
            "Open exact conversation",
          ),
      },
    ];
    render(element(pages, "history"));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Open exact conversation" }));
    await vi.waitFor(() => expect(navigation.local).toHaveBeenCalledOnce());
    expect(navigation.remote).not.toHaveBeenCalled();
    expect(navigation.addTab).toHaveBeenCalledWith("/synthetic-local", {
      workspacePurpose: "conversation",
    });
    expect(navigation.setActiveTask).toHaveBeenCalledWith(
      "/synthetic-local",
      "same-session",
      undefined,
    );
  });
  it("opens an explicit standalone header target and preserves the underlying draft", () => {
    const pages: ApplicationPage[] = [
      { id: "admin", label: "Admin", render: () => createElement("p", null, "admin content") },
      {
        id: "notices",
        label: "Notifications",
        standalone: true,
        render: () => createElement("p", null, "my notifications"),
      },
    ];
    render(
      createElement(
        "div",
        null,
        createElement("input", { "aria-label": "draft", defaultValue: "unsent" }),
        element(pages, "notices"),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText("my notifications")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("unsent");
  });
  it("leaves an unconfigured shell unchanged", () => {
    const result = render(element([]));
    expect(result.container.textContent).toBe("");
  });
  it("opens, refreshes, selects and returns without manufacturing a workspace", () => {
    let renders = 0;
    const first: ApplicationPage = {
      id: "first",
      label: "First",
      render: (context) => {
        expect(context.workspace).toBeUndefined();
        expect(context.rpcReady).toBe(false);
        renders++;
        return createElement("p", null, "content-" + renders);
      },
    };
    render(
      element([
        first,
        {
          id: "second",
          label: "Second",
          render: () => createElement("p", null, "second-content"),
        },
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "First" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("content-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新页面" }));
    expect(screen.getByText("content-2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(screen.getByText("second-content")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "First" })).toBeTruthy();
  });
  it("closes when the selected descriptor is removed", () => {
    const pages = [
      {
        id: "first",
        label: "First",
        render: () => createElement("p", null, "first-content"),
      },
    ];
    const result = render(element(pages));
    fireEvent.click(screen.getByRole("button", { name: "First" }));
    result.rerender(element([]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

it("closes history through its context and keeps the underlying draft and focus", async () => {
  const pages: ApplicationPage[] = [
    {
      id: "history",
      label: "History",
      standalone: true,
      render: (context) => createElement("button", { onClick: context.close }, "Return to work"),
    },
  ];
  render(element(pages, "history"));
  const trigger = screen.getByRole("button", { name: "History" });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "Return to work" }));
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: "Return to work" })).toBeNull(),
  );
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
});

function SidebarHarness({ intent, onConsumed }: {
  intent?: { pageId: string; token: number } | null;
  onConsumed?(): void;
}) {
  const state = useApplicationPageNavigationState();
  const selected = state?.sidebarPages.find((page) => page.id === state.selectedPageId);
  return createElement("div", null,
    createElement(ApplicationPageIntentBridge, { intent, onConsumed }),
    ...state!.sidebarPages.map((page) => createElement("button", {
      key: page.id,
      "aria-pressed": state?.selectedPageId === page.id,
      onClick: () => state?.openPage(page.id),
    }, page.label)),
    selected ? createElement(ApplicationPageContent, {
      render: selected.render, standalone: true, onNavigate: state!.closePage,
    }) : null,
  );
}

it("keeps a sidebar page selected through the real Dialog surface and returns to its trigger", async () => {
  const pages: ApplicationPage[] = [{
    id: "assets", label: "Assets", sidebarOrder: 10,
    render: (context) => createElement("button", { onClick: context.close }, "Back to draft"),
  }];
  render(createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children:
    createElement(ApplicationPages, { pages, children: createElement(SidebarHarness) }),
  }));
  const trigger = screen.getByRole("button", { name: "Assets" });
  trigger.focus();
  fireEvent.click(trigger);
  await vi.waitFor(() => expect(trigger.getAttribute("aria-pressed")).toBe("true"));
  expect(screen.getByRole("button", { name: "Back to draft" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to draft" }));
  expect(trigger.getAttribute("aria-pressed")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

it("consumes successive open intents without closing the selected sidebar page", async () => {
  const consumed = vi.fn();
  const pages: ApplicationPage[] = [{
    id: "assets", label: "Assets", sidebarOrder: 10,
    render: (context) => createElement("button", { onClick: context.close }, "Back to draft"),
  }];
  const tree = (token: number | null) => createElement(ZCodeIntlProvider, {
    initialLocale: "zh-CN", children: createElement(ApplicationPages, { pages,
      children: createElement(SidebarHarness, {
        intent: token === null ? null : { pageId: "assets", token }, onConsumed: consumed,
      }),
    }),
  });
  const result = render(tree(1));
  await vi.waitFor(() => expect(consumed).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "Assets" }).getAttribute("aria-pressed")).toBe("true");
  result.rerender(tree(null));
  fireEvent.click(screen.getByRole("button", { name: "Back to draft" }));
  result.rerender(tree(2));
  await vi.waitFor(() => expect(consumed).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Back to draft" })).toBeTruthy();
});

it("opens only registered settings sections through the native tab and preserves the workspace", () => {
  navigation.openSettings.mockClear();
  const close = vi.fn();
  render(
    createElement(ApplicationSettingsProvider, {
      settings: {
        sections: [
          {
            id: "fixture",
            label: "Fixture",
            group: "basics",
            Icon: Package,
            render: () => createElement("p", null, "settings content"),
          },
        ],
      },
      children: createElement(
        "div",
        null,
        createElement("input", { "aria-label": "workspace draft", defaultValue: "unsent" }),
        createElement(ApplicationPageContent, {
          onNavigate: close,
          render: ({ openSettingsSection }) =>
            createElement(
              "div",
              null,
              createElement(
                "button",
                { onClick: () => openSettingsSection?.("missing") },
                "unknown settings",
              ),
              createElement(
                "button",
                { onClick: () => openSettingsSection?.("fixture") },
                "registered settings",
              ),
            ),
        }),
        createElement(ApplicationSettingsContent),
      ),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "unknown settings" }));
  expect(navigation.openSettings).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "registered settings" }));
  expect(navigation.openSettings).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByText("settings content")).toBeTruthy();
  expect((screen.getByLabelText("workspace draft") as HTMLInputElement).value).toBe("unsent");
});
