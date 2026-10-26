import { SavedConversationThread } from "../conversation-workbench/SavedConversationThread.js";
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
  language?: "zh" | "en";
  title: string;
  workspace: string;
  refresh: string;
  loading: string;
  unavailable: string;
  /** Compact task-navigation summary; diagnostic detail belongs outside the sidebar. */
  sidebarUnavailable?: string;
  /** Trusted display mapping; never render raw service errors. */
  readError?: (error: unknown) => string;
  empty: string;
  saved: string;
  continuationUnavailable: string;
  continueAction?: string;
  showInactive?: string;
  hideInactive?: string;
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
type HistoryState = ReturnType<typeof useConversationHistory>;
type HistoryProps = {
  reader: ConversationHistoryReader;
  labels: ConversationHistoryLabels;
  onWorkspace(): void;
  status?: ReactNode;
  draft?: string;
  onDraftChange?(text: string): void;
  onContinue?(
    session: string,
    location: string,
    instanceId?: string,
    draft?: string,
  ): void | Promise<void>;
  openDownloadDestination?: IPlatformService["openFileDownload"];
};
export function ConversationHistory(
  props: HistoryProps & { history?: HistoryState; session?: string },
) {
  return props.history ? (
    <ConversationHistoryContent {...props} history={props.history} />
  ) : (
    <OwnedConversationHistory {...props} />
  );
}
function OwnedConversationHistory(props: HistoryProps & { session?: string }) {
  const history = useConversationHistory(props.reader);
  return <ConversationHistoryContent {...props} history={history} />;
}
function ConversationHistoryContent({
  reader,
  labels,
  onWorkspace,
  status,
  onContinue,
  openDownloadDestination,
  history,
  session,
  draft,
  onDraftChange,
}: HistoryProps & { history: HistoryState; session?: string }) {
  const downloadFile = useConversationFileDownload(reader, openDownloadDestination);
  const [fileError, setFileError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const fileRequest = useRef<AbortController | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
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
  const Surface = session ? "section" : "main";
  const showVersions = !session || (viewedItem?.candidates.length ?? 0) > 1;
  useEffect(() => {
    fileRequest.current?.abort();
    setContinuing(false);
    setDownloading(false);
    setFileError(false);
    return () => {
      fileRequest.current?.abort();
    };
  }, [viewedKey, reader]);
  const fileControls = (
    <>
      {fileError && <p role="alert">{labels.unavailable}</p>}
      {viewed?.files?.map((file, index) => (
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
          {labels.language === "zh" ? "附件" : "Attachment"} {index + 1}
        </Button>
      ))}
    </>
  );
  if (session)
    return (
      <SavedConversationThread
        key={session}
        initialDraft={draft}
        onDraftChange={onDraftChange}
        reader={reader}
        history={history}
        session={session}
        chinese={labels.language === "zh"}
        failureMessage={labels.readError?.(history.failure) ?? labels.unavailable}
        status={status}
        files={fileControls}
        onReady={(id, location, instance, draft) => onContinue?.(id, location, instance, draft)}
      />
    );
  return (
    <Surface className="bg-background text-foreground flex h-full min-h-0 flex-col overflow-y-auto text-ui-base [&_button]:min-h-11 [&_button:focus-visible]:ring-2 [&_button:focus-visible]:ring-ring">
      <header className="border-border flex flex-wrap items-center gap-3 border-b p-4">
        <h1 className="text-ui-lg flex-1 font-semibold">
          {session ? (viewed?.title ?? labels.title) : labels.title}
        </h1>
        <Button variant="outline" onClick={() => void history.refresh()} disabled={history.loading}>
          {labels.refresh}
        </Button>
        <Button onClick={onWorkspace}>{labels.workspace}</Button>
      </header>
      {viewed && continuing && (
        <p className="text-muted-foreground px-4 py-2 text-ui-caption">
          {labels.continuationUnavailable}
        </p>
      )}
      {status}
      {history.loading && (
        <p role="status" className="px-4">
          {labels.loading}
        </p>
      )}
      {history.failed && !history.choiceError && (
        <p role="alert" className="px-4">
          {labels.readError?.(history.failure) ?? labels.unavailable}
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
      <div
        className={
          "grid min-h-0 flex-1 content-start gap-4 p-4 " +
          (session ? "" : "md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]")
        }
      >
        {showVersions && (
          <nav aria-label={labels.title} className="min-w-0">
            {!history.loading && !history.failed && !history.items.length && <p>{labels.empty}</p>}
            <ul className="space-y-3">
              {history.items
                .filter((item) => !session || item.session === session)
                .map((item) => (
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
                    {(!session || item.candidates.length > 1) &&
                      [...new Set([item.version, ...item.candidates])]
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
            {history.hasMore && !session && (
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
        )}
        <section
          aria-label={history.transcript?.title || labels.choose}
          className="min-w-0 space-y-4"
        >
          {session && viewed && (
            <p className="text-ui-caption text-muted-foreground">{labels.saved}</p>
          )}
          {history.transcript && !session && (
            <h2 className="text-ui-lg break-words font-semibold">{history.transcript.title}</h2>
          )}
          {history.transcript?.deleted && <p role="status">{labels.deleted}</p>}
          {viewed &&
            !viewed.deleted &&
            reader.continuation &&
            labels.continuation &&
            !continuing && (
              <Button onClick={() => setContinuing(true)}>
                {labels.continueAction ?? labels.continuation.open}
              </Button>
            )}
          {viewed &&
            !viewed.deleted &&
            reader.continuation &&
            labels.continuation &&
            continuing && (
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
          {fileControls}
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
    </Surface>
  );
}
