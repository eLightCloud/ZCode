import {
  createContext,
  useContext,
  useEffect,
  useId,
  type ComponentType,
  type ImgHTMLAttributes,
  type ReactNode,
} from "react";
import { logger } from "@/logger.js";

export interface ApplicationBrand {
  name: string;
  localizedNames?: Partial<Record<"zh-CN" | "en-US", string>>;
  attribution?: string;
  /** Add a leading introduction to native onboarding; copy uses localizedMessages. */
  onboardingIntroduction?: boolean;
  localizedMessages?: Partial<Record<"zh-CN" | "en-US", Record<string, string>>>;
  Mark: ComponentType<{ className?: string }>;
  Wordmark: ComponentType<{ className?: string }>;
}

const ApplicationBrandContext = createContext<ApplicationBrand | undefined>(undefined);

/** Static product metadata; owns no account, tenant, theme or execution state. */
export function ApplicationBrandProvider({
  brand,
  children,
}: {
  brand: ApplicationBrand;
  children: ReactNode;
}) {
  const correlationId = useId();
  useEffect(() => {
    logger.info({
      event: "application.brand.applied",
      component: "application-shell",
      outcome: "succeeded",
      correlation_id: correlationId,
      source: "application-provider",
      has_attribution: Boolean(brand.attribution),
    });
  }, [brand, correlationId]);
  return <ApplicationBrandContext value={brand}>{children}</ApplicationBrandContext>;
}

export function useApplicationBrand() {
  return useContext(ApplicationBrandContext);
}

/** Only product-owned titles are substituted; provider / protocol identities stay accurate. */
export function formatApplicationBrandMessage(
  name: string | undefined,
  id: string,
  message: string,
) {
  if (!name) return message;
  if (id === "application.name") return name;
  // 产品配置以前只覆盖少数标题，输入框和设置说明因而泄漏原生产品名。
  // 原生 Provider / Agent / MCP / CDN 身份与权益活动仍按其真实来源显示。
  const sourceOwned =
    id.startsWith("rewards.") ||
    id.startsWith("globalNotice.highspeed.") ||
    id.startsWith("settings.modelProvider.startPlan.");
  if (sourceOwned) return message;
  const chinese = /[\u3400-\u9fff]/.test(message);
  return message
    .replaceAll("ZCode Agent", chinese ? "原生执行引擎" : "Native Agent")
    .replaceAll("ZCode MCP", chinese ? "工具服务" : "Tool Service")
    .replaceAll("ZCode 官方插件", "产品内置插件")
    .replace(/ZCode(?!\s+(?:Agent|MCP|CDN)|\s*官方插件)/g, () => name);
}

/** Product artwork only; plugin icons and content images retain their own identity. */
export function ApplicationBrandImage({
  className,
  alt,
  style,
  ...imageProps
}: ImgHTMLAttributes<HTMLImageElement>) {
  const brand = useApplicationBrand();
  if (!brand) return <img {...imageProps} alt={alt} className={className} style={style} />;
  return (
    <span className={className} style={style} role="img" aria-label={brand.name}>
      <brand.Mark className="size-full" />
    </span>
  );
}
