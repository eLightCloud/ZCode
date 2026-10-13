// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import darkEmptyStateLogoUrl from "@/assets/Z.svg";
import { ApplicationBrandProvider } from "@/application-brand.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";

afterEach(() => {
  cleanup();
});

describe("ConversationDraftEmptyState logo", () => {
  it("uses the configured mark instead of native artwork for the draft greeting", () => {
    const Mark = ({ className }: { className?: string }) =>
      createElement("svg", { className, "data-brand": "test-mark", viewBox: "0 0 256 256" });
    const { container } = render(
      createElement(ApplicationBrandProvider, {
        brand: { name: "Example Application", Mark, Wordmark: Mark },
        children: createElement(ZCodeIntlProvider, {
          initialLocale: "zh-CN",
          children: createElement(ConversationDraftEmptyState),
        }),
      }),
    );

    const mark = container.querySelector('[data-brand="test-mark"]');
    expect(mark).not.toBeNull();
    expect(mark?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(mark?.parentElement?.className).toContain("pointer-events-none");
    expect(mark?.parentElement?.className).toContain("aspect-square");
    expect(mark?.parentElement?.className).not.toContain("mask-image");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(container.querySelector('[data-v4-draft-greeting="true"]')?.textContent).toBeTruthy();
  });

  it("uses the supplied Z.svg asset only in dark mode", () => {
    const { container } = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationDraftEmptyState),
      ),
    );

    const lightLogo = container.querySelector("svg");
    const darkLogo = container.querySelector('[data-v4-draft-logo="dark"]');
    const logoContainer = darkLogo?.parentElement;
    const lightLogoClassName = lightLogo?.getAttribute("class") ?? "";
    const darkLogoClassName = darkLogo?.getAttribute("class") ?? "";
    const logoContainerClassName = logoContainer?.getAttribute("class") ?? "";

    expect(lightLogo).not.toBeNull();
    expect(lightLogoClassName).toContain("dark:hidden");
    expect(lightLogoClassName).toContain("opacity-70");
    expect(lightLogoClassName).toContain("mask-image:linear-gradient");
    expect(darkLogo).not.toBeNull();
    expect(darkLogo?.getAttribute("src")).toBe(darkEmptyStateLogoUrl);
    expect(darkLogoClassName).toContain("hidden");
    expect(darkLogoClassName).toContain("dark:block");
    expect(darkLogoClassName).not.toContain("opacity-70");
    expect(darkLogoClassName).not.toContain("mask-image:linear-gradient");
    expect(logoContainerClassName).not.toContain("opacity-70");
    expect(logoContainerClassName).not.toContain("mask-image:linear-gradient");
  });
});
