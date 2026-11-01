// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApplicationBrandProvider } from "@/application-brand.js";
import { WindowsTopLeftLogo } from "@/WindowsTopLeftLogo.js";

const Mark = ({ className }: { className?: string }) =>
  createElement("svg", { className, "data-brand": "settings-mark" });
const brand = { name: "Example Application", Mark, Wordmark: Mark };

describe("Windows settings logo layout", () => {
  it.each([false, true])("keeps the logo outside the settings grid (branded=%s)", (branded) => {
    const logo = createElement(WindowsTopLeftLogo, {
      className: "isolate",
      imageClassName: "opacity-90",
    });
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      branded ? createElement(ApplicationBrandProvider, { brand, children: logo }) : logo,
    );
    // 企业标识只能替换容器内的图案；提前返回 SVG 会成为第三个 grid item，挤走导航与正文。
    const frame = container.firstElementChild!;
    expect(frame.classList.contains("absolute")).toBe(true);
    expect(frame.classList.contains("[app-region:drag]")).toBe(true);
    expect(frame.classList.contains("isolate")).toBe(true);
    const image = frame.querySelector('[role="img"]')!;
    expect(image.getAttribute("aria-label")).toBe(branded ? brand.name : "ZCode");
    expect(image.classList.contains("size-5")).toBe(true);
    expect(image.classList.contains("opacity-90")).toBe(true);
    expect(Boolean(image.querySelector('[data-brand="settings-mark"]'))).toBe(branded);
    expect(image.querySelector("animate")).toBeNull();
  });
});
