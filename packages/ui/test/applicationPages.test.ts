// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ApplicationPages,
  ApplicationPageHeaderAction,
  type ApplicationPage,
} from "@/root/ApplicationPages.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
const navigation = vi.hoisted(() => ({
  addTab: vi.fn(),
  setActiveTask: vi.fn(),
  local: vi.fn(async () => ({ workspacePath: "/synthetic-local" })),
  remote: vi.fn(async () => ({ workspacePath: "/synthetic-remote" })),
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: () => undefined,
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
