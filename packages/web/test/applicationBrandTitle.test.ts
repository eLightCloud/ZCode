import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationShareLandingStatus, ConversationShareLandingPage } from "../src/share/ConversationShareLandingPage.js";
// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { setApplicationDocumentTitle } from "../src/applicationBrandTitle.js";
beforeEach(() => {
  document.head.innerHTML = "";
});
it("preserves native titles without application metadata", () => {
  setApplicationDocumentTitle("ZCode - Web + Server");
  expect(document.title).toBe("ZCode - Web + Server");
});
it("keeps the configured product title across native bootstrap routes", () => {
  const meta = document.createElement("meta");
  meta.name = "application-name";
  meta.content = "Example Product";
  document.head.append(meta);
  setApplicationDocumentTitle("ZCode - Web Remote Control");
  expect(document.title).toBe("Example Product");
  setApplicationDocumentTitle("ZCode - Web + Server");
  expect(document.title).toBe("Example Product");
});

it("brands standalone share status while preserving structured provider copy", () => {
  document.head.innerHTML = '<meta name="application-name" content="Example Product">';
  for (const state of [{ kind: "loading" }, { kind: "login_required" }] as const) {
    const html = renderToStaticMarkup(createElement(ConversationShareLandingStatus, { state, locale: "en-US" }));
    expect(html).toContain("Example Product Conversation Share");
    expect(html).not.toContain("ZCode Conversation Share");
  }
});

it("renders branded share content with a theme-specific logo and the native import protocol", () => {
  document.head.innerHTML = '<meta name="application-name" content="Example Product"><link rel="icon" href="https://example.test/application-brand/favicon.svg">';
  const preview = { schema_version: 1 as const, share: { title: "Shared result", access_mode: "public_importable" as const, created_at: 1000, expires_at: 2000 }, rows: [], artifacts: [], integrity: { projection_sha256: "a".repeat(64), artifact_set_sha256: "b".repeat(64) } };
  for (const theme of ["zai-light", "zai-dark"] as const) {
    const html = renderToStaticMarkup(createElement(ConversationShareLandingPage, { shareCode: "fixture", preview, locale: "en-US", theme }));
    expect(html).toContain(theme === "zai-dark" ? "mark-white.svg" : "mark-black.svg");
    expect(html).toContain("Example Product");
    expect(html).toContain("zcode://share/import?code=fixture");
    expect(html).not.toContain("Download ZCode");
  }
});
