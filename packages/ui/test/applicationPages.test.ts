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

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: () => undefined,
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => ({ services: {}, rpcReady: false }),
}));
vi.mock("@/DesktopOverlayWindowControls.js", () => ({
  DesktopOverlayWindowControls: () => null,
}));
afterEach(cleanup);
function element(pages: ApplicationPage[]) {
  return createElement(ZCodeIntlProvider, {
    initialLocale: "zh-CN",
    children: createElement(TooltipProvider, {
      children: createElement(ApplicationPages, {
        pages,
        children: createElement(ApplicationPageHeaderAction),
      }),
    }),
  });
}
describe("trusted application page lifecycle", () => {
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
