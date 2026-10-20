// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginIcon } from "../src/components/PluginIcon.js";

vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
afterEach(cleanup);

it("falls back after failure and retries when the actual icon source changes", () => {
  const view = render(createElement(PluginIcon, { src: "https://example.test/old.png" }));
  fireEvent.error(view.container.querySelector("img")!);
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.container.querySelector(".lucide-blocks")).toBeTruthy();
  view.rerender(createElement(PluginIcon, { src: "https://example.test/restored.png" }));
  expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
    "https://example.test/restored.png",
  );
  expect(view.container.querySelector(".lucide-blocks")).toBeNull();
});
