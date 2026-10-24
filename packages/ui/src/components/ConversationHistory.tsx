import type { ConversationHistoryReader } from "@zcode/shared";
import type { IPlatformService } from "@zcode/shared";
import { useConversationFileDownload } from "../hooks/useConversationFileDownload.js";
import { useConversationHistory } from "../hooks/useConversationHistory.js";
import { Button } from "./ui/button.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ConversationContinuation,
  type ConversationContinuationLabels,
} from "./ConversationContinuation.js";

export interface ConversationHistoryLabels {
  title: string;
  workspace: string;
  refresh: string;
  loading: string;
  unavailable: string;
  empty: string;
  saved: string;
  continuationUnavailable: string;
  archived: string;
  pinned?: string;
  deleted: string;
  unknownIndex: string;
  conflict: string;
  more: string;
  choose: string;
  user: string;
  assistant: string;
  continuation?: ConversationContinuationLabels;
  deletionChoice?: {
    action: string;
    warning: string;
    confirm: string;
    cancel: string;
    retry: string;
    succeeded: string;
    stale: string;
    blocked: string;
    unavailable: string;
  };
}
/** Native history before a Host/Core connection; optional explicit choices never activate execution. */
export function ConversationHistory({
  reader,
  labels,
  onWorkspace,
  status,
  onContinue,
  openDownloadDestination,
}: {
  reader: ConversationHistoryReader;
  labels: ConversationHistoryLabels;
  onWorkspace(): void;
  status?: ReactNode;
  onContinue?(session: string, location: string, instanceId?: string): void;
  openDownloadDestination?: IPlatformService["openFileDownload"];
}) {
  const history = useConversationHistory(reader);
  const downloadFile = useConversationFileDownload(reader, openDownloadDestination);
  const [fileError, setFileError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const fileRequest = useRef<AbortController | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const choiceLabels = labels.deletionChoice;
  const viewed = history.transcript;
  const viewedItem = history.items.find((item) => item.session === viewed?.session);
  const deletionChoice = !!(
    reader.chooseDeletion &&
    choiceLabels &&
    viewed?.deleted &&
    viewedItem?.candidates.includes(viewed.version) &&
    viewedItem.selected !== viewed.version
  );
  const viewedKey = viewed ? viewed.session + ":" + viewed.version : null;
  useEffect(() => {
    fileRequest.current?.abort();
    setDownloading(false);
    setFileError(false);
    return () => {
      fileRequest.current?.abort();
    };
  }, [viewedKey, reader]);
  return (
    <main className="bg-background text-foreground flex h-full min-h-0 flex-col overflow-y-auto text-ui-base [&_button]:min-h-11 [&_button:focus-visible]:ring-2 [&_button:focus-visible]:ring-ring">
      <header className="border-border flex flex-wrap items-center gap-3 border-b p-4">
        <h1 className="text-ui-lg flex-1 font-semibold">{labels.title}</h1>
        <Button variant="outline" onClick={() => void history.refresh()} disabled={history.loading}>
          {labels.refresh}
        </Button>
        <Button onClick={onWorkspace}>{labels.workspace}</Button>
      </header>
      <p className="text-muted-foreground px-4 py-2 text-ui-caption">
        {labels.continuationUnavailable}
      </p>
      {status}
      {history.loading && (
        <p role="status" className="px-4">
          {labels.loading}
        </p>
      )}
      {history.failed && !history.choiceError && (
        <p role="alert" className="px-4">
          {labels.unavailable}
        </p>
      )}
      {choiceLabels && history.choiceDone && (
        <p role="status" className="px-4">
          {choiceLabels.succeeded}
        </p>
      )}
      {choiceLabels && history.choiceError && (
        <div className="space-y-2 px-4">
          <p role="alert">
            {history.choiceError === "stale"
              ? choiceLabels.stale
              : history.choiceError === "blocked" || history.choiceError === "scope"
                ? choiceLabels.blocked
                : choiceLabels.unavailable}
          </p>
          {history.canRetryChoice && (
            <Button
              variant="outline"
              disabled={history.loading}
              onClick={() => void history.retryChoice()}
            >
              {choiceLabels.retry}
            </Button>
          )}
        </div>
      )}
      <div className="grid min-h-0 flex-1 content-start gap-4 p-4 md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
        <nav aria-label={labels.title} className="min-w-0">
          {!history.loading && !history.failed && !history.items.length && <p>{labels.empty}</p>}
          <ul className="space-y-3">
            {history.items.map((item) => (
              <li key={item.session} className="border-border rounded-md border p-3">
                <p className="break-words font-medium">
                  {item.title || (item.management?.deleted ? labels.deleted : item.session)}
                </p>
                <p className="text-muted-foreground text-ui-caption">
                  {labels.saved}
                  {item.management?.archived && ` · ${labels.archived}`}
                  {item.management?.pinned && labels.pinned && ` · ${labels.pinned}`}
                  {item.management?.deleted && ` · ${labels.deleted}`}
                  {!item.management && ` · ${labels.unknownIndex}`}
                  {item.candidates.length > 1 && ` · ${labels.conflict}`}
                </p>
                {[...new Set([item.version, ...item.candidates])]
                  .filter((version): version is string => !!version)
                  .map((version, index) => (
                    <Button
                      key={version}
                      variant="outline"
                      className="mt-2 mr-2 min-h-11"
                      disabled={history.loading}
                      onClick={() => {
                        setConfirming(null);
                        void history.open(item.session, version);
                      }}
                    >
                      {labels.choose} {index + 1}
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
          {history.hasMore && (
            <Button
              variant="outline"
              className="mt-3"
              disabled={history.loading}
              onClick={() => void history.more()}
            >
              {labels.more}
            </Button>
          )}
        </nav>
        <section
          aria-label={history.transcript?.title || labels.choose}
          className="min-w-0 space-y-4"
        >
          {history.transcript && (
            <h2 className="text-ui-lg break-words font-semibold">{history.transcript.title}</h2>
          )}
          {history.transcript?.deleted && <p role="status">{labels.deleted}</p>}
          {viewed && !viewed.deleted && reader.continuation && labels.continuation && (
            <ConversationContinuation
              key={viewed.session + ":" + viewed.version}
              reader={reader}
              session={viewed.session}
              version={viewed.version}
              labels={labels.continuation}
              onReady={onContinue}
            />
          )}
          {deletionChoice &&
            choiceLabels &&
            (confirming === viewedKey ? (
              <div
                role="group"
                aria-label={choiceLabels.action}
                className="border-border space-y-3 rounded-md border p-3"
                onKeyDown={(event) => {
                  if (event.key === "Escape") setConfirming(null);
                }}
              >
                <p>{choiceLabels.warning}</p>
                <div className="flex flex-wrap gap-3">
                  <Button
                    autoFocus
                    variant="outline"
                    disabled={history.loading}
                    onClick={() => setConfirming(null)}
                  >
                    {choiceLabels.cancel}
                  </Button>
                  <Button
                    disabled={history.loading}
                    onClick={() => {
                      setConfirming(null);
                      void history.chooseDeletion();
                    }}
                  >
                    {choiceLabels.confirm}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                disabled={history.loading}
                onClick={() => setConfirming(viewedKey)}
              >
                {choiceLabels.action}
              </Button>
            ))}
          {!!viewed?.effects?.length && (
            <div role="status" className="border-border rounded-md border p-3 text-ui-caption">
              <p>{labels.continuation?.warning}</p>
              {viewed.effects.map((effect) => (
                <p
                  className="break-all"
                  key={JSON.stringify([
                    effect.server,
                    effect.owner,
                    effect.operation,
                    effect.requestKey,
                  ])}
                >
                  {effect.owner} · {effect.operation} · {effect.outcome} · {effect.requestKey}
                </p>
              ))}
            </div>
          )}
          {fileError && <p role="alert">{labels.unavailable}</p>}
          {viewed?.files?.map((file) => (
            <Button
              key={file.uri}
              variant="outline"
              disabled={!reader.file || downloading}
              aria-busy={downloading}
              onClick={() => {
                const current = viewed;
                setFileError(false);
                setDownloading(true);
                const controller = new AbortController();
                fileRequest.current?.abort();
                fileRequest.current = controller;
                void downloadFile(current.session, current.version, file, controller.signal)
                  .catch(() => {
                    if (!controller.signal.aborted) setFileError(true);
                  })
                  .finally(() => {
                    if (!controller.signal.aborted) setDownloading(false);
                  });
              }}
            >
              {file.contentType} · {file.bytes} B
            </Button>
          ))}
          {history.transcript?.messages.map((message) => (
            <article key={message.id} className="border-border rounded-md border p-4">
              <h3 className="text-muted-foreground text-ui-caption">
                {message.role === "user" ? labels.user : labels.assistant}
              </h3>
              <p className="whitespace-pre-wrap break-words">{message.text}</p>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
