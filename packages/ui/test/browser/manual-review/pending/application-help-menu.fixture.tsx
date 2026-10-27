import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { ApplicationBrandProvider } from "@/application-brand.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ApplicationPeripheralsProvider } from "@/root/ApplicationPeripherals.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import "@/styles.css";

// 浏览器场景：实际 Radix 菜单、键盘选择与注入回调；不连接账号或发送反馈。
const params = new URLSearchParams(location.search);
document.body.style.background = "var(--color-background)";
document.body.style.color = "var(--color-foreground)";
document.documentElement.className =
  params.get("theme") === "light" ? "theme-zai-light" : "theme-zai-dark";
const services = {
  clientConfigService: {
    getSnapshot: async () => {
      throw new Error("native_config_must_not_be_requested");
    },
  },
} as unknown as IServiceAccessor;
const platform = {
  openExternal: () => {},
  executeDesktopCommand: async () => {},
} as unknown as IPlatformService;

function Fixture() {
  const [action, setAction] = useState("");
  const feedback = () => setAction("同一反馈中心已打开");
  return (
    <ApplicationBrandProvider brand={{ name: "翼辉睿观", Mark: () => null, Wordmark: () => null }}>
      <PlatformProvider platform={platform}>
        <ServiceProvider services={services}>
          <ZCodeIntlProvider initialLocale="zh-CN">
            <TooltipProvider>
              <ApplicationPeripheralsProvider
                value={{
                  nativeCloudEnabled: false,
                  openHelp: () => setAction("管理后端公开产品文档已打开"),
                  openFeedback: feedback,
                  openShare: () => {},
                  renderModelPlans: () => null,
                }}
              >
                <main className="flex justify-end items-start gap-2 p-6">
                  <button onClick={feedback}>反馈</button>
                  <WorkspaceHelpMenuButton isDesktop={params.get("desktop") !== "0"} />
                  <output role="status">{action}</output>
                </main>
              </ApplicationPeripheralsProvider>
            </TooltipProvider>
          </ZCodeIntlProvider>
        </ServiceProvider>
      </PlatformProvider>
    </ApplicationBrandProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
