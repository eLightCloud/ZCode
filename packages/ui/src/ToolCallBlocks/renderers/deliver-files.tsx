import { readToolResultDisplay } from "../toolResultDisplay.js";
import { useMemo, useState } from "react";
import { type NativeDeliverable } from "@zcode/shared";
import { useApplicationPeripherals } from "@/root/ApplicationPeripherals.js";
import { useFileDownload } from "@/hooks/useFileDownload.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { FallbackToolCallBlock } from "./fallback.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

export function DeliverFilesToolCallBlock(context: ToolCallBlockRenderContext) {
  const application = useApplicationPeripherals();
  const { toolCall } = context.toolCallNode;
  const { intl } = useZCodeIntl();
  const display = useMemo(() => readToolResultDisplay(toolCall.raw), [toolCall.raw]);
  const files = useMemo(
    () =>
      display?.kind === "deliver_files"
        ? display.result.files
            .filter((entry) => entry.status === "delivered")
            .map((entry) => entry.file)
        : [],
    [display],
  );
  if (display?.kind !== "deliver_files") return <FallbackToolCallBlock {...context} />;
  return (
    <section className="rounded-xl border border-border bg-surface p-3 text-ui-base">
      <h3>{intl.formatMessage({ id: "delivery.files" })}</h3>
      {!application?.renderDeliverables &&
        files.map((file) => (
          <NativeDeliveryFile
            key={`${file.id}:${file.version}`}
            file={file}
            workspacePath={context.workspacePath}
          />
        ))}
      {display.result.files.some((entry) => entry.status === "failed") && (
        <p role="alert">{intl.formatMessage({ id: "delivery.partialFailure" })}</p>
      )}
      {application?.renderDeliverables?.(files, context.workspacePath)}
    </section>
  );
}

function NativeDeliveryFile({
  file,
  workspacePath,
}: {
  file: NativeDeliverable;
  workspacePath: string;
}) {
  const { busy, downloadDeliverable } = useFileDownload();
  const { intl } = useZCodeIntl();
  const [error, setError] = useState<"delivery.streamingRequired" | "delivery.downloadFailed">();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 py-1">
      <span className="min-w-0 break-all">{file.name}</span>
      <span className="text-ui-caption text-foreground-subtle">{file.size} B</span>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setError(undefined);
          void downloadDeliverable(
            {
              workspacePath,
              ...(file.workspaceKey !== workspacePath
                ? { workspaceIdentity: file.workspaceKey }
                : {}),
            },
            file,
          ).catch((failure: unknown) =>
            setError(
              (failure as Error).message === "file_download_streaming_required"
                ? "delivery.streamingRequired"
                : "delivery.downloadFailed",
            ),
          );
        }}
      >
        {intl.formatMessage({ id: busy ? "delivery.downloading" : "delivery.downloadSource" })}
      </Button>
      {error && <span role="alert">{intl.formatMessage({ id: error })}</span>}
    </div>
  );
}
