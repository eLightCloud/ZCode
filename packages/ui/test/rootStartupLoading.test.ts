import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RootStartupLoading, ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";
import { ApplicationBrandProvider } from "@/application-brand.js";

const Mark = ({ className }: { className?: string }) =>
  createElement("svg", { className, viewBox: "0 0 256 256", "data-brand": "startup-mark" });
const brand = { name: "Example Application", Mark, Wordmark: Mark };

describe("RootStartupLoading", () => {
  it("品牌启动阻塞态使用装配标识并保留动画与无障碍加载语义", () => {
    const html = renderToStaticMarkup(
      createElement(ApplicationBrandProvider, {
        brand,
        children: createElement(RootStartupLoading, { label: "加载中..." }),
      }),
    );
    expect(html).toContain('data-brand="startup-mark"');
    expect(html).not.toContain("M134.4");
    expect(html).not.toContain('viewBox="0 0 256 218"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="加载中..."');
    expect(html).toContain('values="1;0.4;1"');
  });
  it("品牌引导图标关闭动画时仍使用装配标识", () => {
    const html = renderToStaticMarkup(
      createElement(ApplicationBrandProvider, {
        brand,
        children: createElement(ZCodeStartupLogoBadge, { animated: false }),
      }),
    );
    expect(html).toContain('data-brand="startup-mark"');
    expect(html).not.toContain("M134.4");
    expect(html).not.toContain("<animate");
  });
  it("静态品牌图标不渲染呼吸动画", () => {
    const html = renderToStaticMarkup(createElement(ZCodeStartupLogoBadge, { animated: false }));
    expect(html).toContain("<svg");
    expect(html).not.toContain("<animate");
  });
  it("启动阻塞态使用整体呼吸的 ZCode SVG 而不是可见 loading 文案", () => {
    const html = renderToStaticMarkup(createElement(RootStartupLoading, { label: "加载中..." }));

    expect(html).toContain('data-testid="root-startup-loading"');
    expect(html).toContain('aria-label="加载中..."');
    expect(html).toContain("<svg");
    expect(html).toContain('attributeName="opacity"');
    expect(html).not.toContain(">加载中...<");
  });
});
