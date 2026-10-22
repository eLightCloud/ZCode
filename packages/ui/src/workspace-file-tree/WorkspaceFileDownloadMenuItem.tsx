import { useFileDownload } from "@/hooks/useFileDownload.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ContextMenuItem } from "@/components/ui/context-menu.js";
import { toast } from "@/components/ui/toast.js";

export function WorkspaceFileDownloadMenuItem({
  path,
  disabled,
}: {
  path: string;
  disabled: boolean;
}) {
  const { busy, downloadFile } = useFileDownload();
  const { intl } = useZCodeIntl();
  return (
    <ContextMenuItem
      disabled={disabled || busy}
      onSelect={() => {
        void downloadFile(path).catch((error: unknown) =>
          toast(
            intl.formatMessage({
              id:
                (error as Error).message === "file_download_streaming_required"
                  ? "delivery.streamingRequired"
                  : "delivery.downloadFailed",
            }),
          ),
        );
      }}
    >
      {intl.formatMessage({ id: busy ? "delivery.downloading" : "delivery.downloadFile" })}
    </ContextMenuItem>
  );
}
