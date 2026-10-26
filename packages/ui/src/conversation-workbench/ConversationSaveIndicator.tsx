import { CloudAlertIcon, CloudCheckIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

/** Read-only row decoration; saved content is not a new execution or sync guarantee. */
export function ConversationSaveIndicator({
  label,
  conflict = false,
}: {
  label: string;
  conflict?: boolean;
}) {
  const Icon = conflict ? CloudAlertIcon : CloudCheckIcon;
  return (
    <ControlHintTooltip title={label} side="top">
      <span
        role="img"
        aria-label={label}
        className={`inline-flex size-4 shrink-0 items-center justify-center ${conflict ? "text-warning" : "text-foreground-subtle"}`}
      >
        <Icon aria-hidden="true" className="size-3.5" />
      </span>
    </ControlHintTooltip>
  );
}
