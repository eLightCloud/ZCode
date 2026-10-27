import { useRef, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";

/** Public application surface preserving native focus, escape and modal semantics. */
export function ApplicationDialog({
  title,
  onClose,
  children,
  className,
  open = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  open?: boolean;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        onOpenAutoFocus={() => {
          // 受控应用浮层没有原生 DialogTrigger；在自动聚焦前记住实际触发控件。
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus({ preventScroll: true });
          }
        }}
        className={cn(
          "max-h-[85dvh] w-[min(64rem,calc(100vw-2rem))] max-w-none overflow-auto p-0",
          className,
        )}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
