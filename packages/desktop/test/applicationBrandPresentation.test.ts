import { describe, expect, it } from "vitest";
import {
  indicatorHtml,
  indicatorWindowSize,
} from "../src/main/windowsCuaOperationIndicatorContent.js";
import { buildWindowsOpenFolderRegistryOperations } from "../src/main/desktopWindowsOpenFolderContextMenu.js";
import { resolveCuaPermissionPanelMessages } from "../src/renderer/cuaPermissionPanelMessages.js";

describe("application branding in system surfaces", () => {
  it("keeps the native fallback and accommodates longer application names without HTML injection", () => {
    expect(indicatorHtml("en-US")).toContain("ZCode is controlling your computer");
    const name = "Example & Product <Desktop>";
    const html = indicatorHtml("en-US", name);
    expect(html).toContain("Example &amp; Product &lt;Desktop&gt;");
    expect(html).not.toContain("ZCode is controlling");
    expect(indicatorWindowSize("en-US", name).width).toBeGreaterThan(
      indicatorWindowSize("en-US").width,
    );
  });
  it("brands Explorer labels while retaining executable targets and registry ownership", () => {
    const operations = buildWindowsOpenFolderRegistryOperations({
      executablePath: "C:\\Apps\\Example.exe",
      locale: "en-US",
      applicationName: "Example Product",
    });
    expect(operations[0]?.args).toContain("Open in Example Product");
    expect(operations[0]?.args[1]).toContain("ZCode.OpenInZCode");
    expect(operations[3]?.args).toContain('"C:\\Apps\\Example.exe" --open-workspace "%1"');
  });
  it("brands permission window titles while preserving permission terminology", () => {
    const messages = resolveCuaPermissionPanelMessages("zh-CN", "accessibility", "示例产品");
    expect(messages.documentTitle).toBe("示例产品 Computer Use 权限");
    expect(messages.permissionLabel).toBe("辅助功能");
  });
});
