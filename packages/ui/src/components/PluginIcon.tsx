import { BUNDLED_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { useApplicationBrand } from "@/application-brand.js";
import { useState, type ReactNode } from "react";
import { Blocks } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { resolvePluginIconSource } from "@/lib/pluginIconSource.js";
import { logger } from "@/logger.js";

/** Plugin 原始图标；支持官方内置图标与 HTTPS，缺失或失败时使用调用方兜底，默认回退 Blocks。 */
export function PluginIcon({
  src,
  pluginId,
  className,
  iconClassName,
  fallbackIcon,
}: {
  src?: string;
  pluginId?: string;
  className?: string;
  iconClassName?: string;
  fallbackIcon?: ReactNode;
}) {
  const brand = useApplicationBrand();
  // 指南属于产品帮助，安装身份保持原值；完整身份匹配避免覆盖同名个人插件。
  const useProductMark = Boolean(brand && isApplicationGuidePlugin(pluginId, src));
  const [failedSrc, setFailedSrc] = useState<string>();
  const resolvedSrc = resolvePluginIconSource(pluginId, src);
  const showImage = Boolean(resolvedSrc) && failedSrc !== resolvedSrc;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 select-none items-center justify-center overflow-hidden rounded-xl bg-surface",
        !showImage && "text-foreground-subtle",
        className,
      )}
    >
      {useProductMark && brand ? (
        <brand.Mark className="size-full p-1 text-foreground" />
      ) : showImage ? (
        <img
          src={resolvedSrc}
          alt=""
          draggable={false}
          className="size-full object-contain"
          onError={() => {
            setFailedSrc(resolvedSrc);
            logger.warn("plugin.icon.load", { outcome: "failed", reasonCode: "image_load_failed" });
          }}
        />
      ) : fallbackIcon ? (
        fallbackIcon
      ) : (
        <Blocks className={cn("size-4", iconClassName)} />
      )}
    </span>
  );
}

/** Only the product-owned guide may adopt application artwork; personal plugins keep theirs. */
export function isApplicationGuidePlugin(pluginId: string | undefined, icon?: string): boolean {
  if (pluginId) {
    const separator = pluginId.lastIndexOf("@");
    const marketplace = pluginId.slice(separator + 1);
    return (
      pluginId.slice(0, separator) === "zcode-guide" &&
      (marketplace === BUNDLED_PLUGIN_MARKETPLACE_ID || marketplace === "zcode-plugins-official")
    );
  }
  return icon === "https://cdn-zcode.z.ai/zcode/official-plugin/assets/zcode-guide/icon.png";
}
