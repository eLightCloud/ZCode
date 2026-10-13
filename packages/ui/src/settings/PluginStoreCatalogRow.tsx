import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
/** Shared compact store row for native and trusted application catalogs. */
export function PluginStoreCatalogRow({
  avatar,
  actions,
  children,
  className,
  ...props
}: ComponentProps<"div"> & {
  avatar: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div
      {...props}
      className={cn(
        "group/card flex min-w-0 items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
        className,
      )}
    >
      {avatar}
      <div className="min-w-0 flex-1">{children}</div>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </div>
  );
}
