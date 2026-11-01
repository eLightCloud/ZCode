import { useApplicationBrand } from "@/application-brand.js";
import { cn } from "@/components/lib/utils.js";
import { ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";

export function WindowsTopLeftLogo({
  className,
  imageClassName,
}: {
  className?: string;
  imageClassName?: string;
}) {
  const brand = useApplicationBrand();

  return (
    <div
      className={cn(
        // Logo 底座和外部占位统一为 20px，保留原中心点（27px / 29px）。
        "absolute left-1 top-1 mt-px ml-px z-20 flex h-12 items-center px-3 [app-region:drag]",
        className,
      )}
    >
      <span
        role="img"
        aria-label={brand?.name ?? "ZCode"}
        data-testid="settings-logo"
        className={cn(
          "pointer-events-none flex size-5 items-center justify-center select-none",
          imageClassName,
        )}
      >
        {/* 品牌只替换图案，不能绕过绝对定位容器：裸 SVG 会占用设置页 grid，挤走导航和正文。 */}
        {brand ? (
          <brand.Mark className="size-5" />
        ) : (
          <ZCodeStartupLogoBadge size="titlebar" animated={false} />
        )}
      </span>
    </div>
  );
}
