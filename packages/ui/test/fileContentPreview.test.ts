// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FileContentPreview } from "@/previewPaneContent.js";
import {
  createStaticHtmlDocument,
  StaticHtmlPreview,
} from "@/components/ai-elements/web-preview.js";

vi.mock("@/hooks/usePreviewViewerLabels.js", () => ({
  usePdfViewerLabels: () => ({}),
  usePptxViewerLabels: () => ({}),
}));
vi.mock("@/previewPaneOfficeContent.js", () => ({
  PreviewPaneOfficeContent: (props: { kind: string }) =>
    createElement("div", null, `office:${props.kind}`),
}));
vi.mock("@/previewPanePdfContent.js", () => ({
  PdfPreviewContent: () => createElement("div", null, "native-pdf"),
}));
vi.mock("@/previewPanePptxContent.js", () => ({
  PptxPreviewContent: () => createElement("div", null, "native-pptx"),
}));
vi.mock("@/previewPaneMarkdownContent.js", () => ({
  MarkdownPreviewContent: () => createElement("div", null, "native-markdown"),
}));
vi.mock("@/previewPaneCodeContent.js", () => ({
  CodeContent: (props: { language: string }) =>
    createElement("div", null, `code:${props.language}`),
}));
afterEach(cleanup);

it.each([
  ["readme.md", "native-markdown"],
  ["config.yaml", "code:yaml"],
  ["main.py", "code:python"],
  ["app.tsx", "code:tsx"],
])("%s reuses the native content renderer", (name, result) => {
  render(createElement(FileContentPreview, { name, source: { kind: "text", text: "synthetic" } }));
  expect(screen.getByText(result)).toBeTruthy();
});
it.each(["docx", "doc", "excel"] as const)(
  "%s reuses the existing read-only Office component",
  (officeKind) => {
    render(
      createElement(FileContentPreview, {
        name: "synthetic",
        source: { kind: "office", data: new ArrayBuffer(1), officeKind, reference: "opaque" },
      }),
    );
    expect(screen.getByText(`office:${officeKind}`)).toBeTruthy();
  },
);
it("PDF and slides use the existing viewers", () => {
  const view = render(
    createElement(FileContentPreview, {
      name: "synthetic.pdf",
      source: { kind: "pdf", data: new ArrayBuffer(1) },
    }),
  );
  expect(screen.getByText("native-pdf")).toBeTruthy();
  view.rerender(
    createElement(FileContentPreview, {
      name: "synthetic.pptx",
      source: { kind: "pptx", data: new ArrayBuffer(1) },
    }),
  );
  expect(screen.getByText("native-pptx")).toBeTruthy();
});
it("HTML retains static content while removing scripts, navigation, forms and remote resources", () => {
  const source = createStaticHtmlDocument(
    '<meta http-equiv="refresh" content="0;url=https://example.test"><base href="https://example.test"><style>h1 {color:red}</style><h1>内容</h1><a href="javascript:alert(1)" onclick="alert(2)">link</a><img src="https://example.test/tracker"><iframe srcdoc="unsafe"></iframe><script>alert(3)</script><form action="https://example.test">form</form>',
  );
  const dom = new DOMParser().parseFromString(source, "text/html");
  expect(dom.querySelector("h1")?.textContent).toBe("内容");
  expect(dom.querySelector("style")?.textContent).toContain("color:red");
  expect(dom.querySelector("script,base,iframe,form,[href],[src],[onclick]")).toBeNull();
  expect(dom.querySelector('meta[http-equiv="refresh"]')).toBeNull();
  expect(
    dom.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
  ).toContain("default-src 'none'");
  const view = render(
    createElement(StaticHtmlPreview, { title: "HTML", content: "<h1>内容</h1>" }),
  );
  const frame = view.container.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
});
