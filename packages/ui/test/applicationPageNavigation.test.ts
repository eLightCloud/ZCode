import { describe, expect, it } from "vitest";
import { selectSidebarPages } from "@/root/ApplicationPageNavigation.js";
import type { ApplicationPage } from "@/root/ApplicationPages.js";

function page(id: string, sidebarOrder?: number): ApplicationPage {
  return { id, label: id, sidebarOrder, render: () => null };
}

describe("application sidebar page ordering", () => {
  it("按 sidebarOrder 升序排列，同值保持注册顺序", () => {
    const pages = [page("assets", 10), page("help"), page("shop", 5), page("auto", 10)];
    expect(selectSidebarPages(pages).map((entry) => entry.id)).toEqual(["shop", "assets", "auto"]);
  });

  it("未注册顺序的页面不进入侧栏清单", () => {
    expect(selectSidebarPages([page("help"), page("assets", 1)]).map((e) => e.id)).toEqual(["assets"]);
    expect(selectSidebarPages([page("help")])).toEqual([]);
  });
});
