import type { ConversationHistoryReader } from "@zcode/shared";
import { useConversationHistory } from "../hooks/useConversationHistory.js";
import { Button } from "./ui/button.js";
import type { ReactNode } from "react";

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
}
/** Native read-only history surface, usable before a Host/Core connection exists. */
export function ConversationHistory({
  reader,
  labels,
  onWorkspace,
  status,
}: {
  reader: ConversationHistoryReader;
  labels: ConversationHistoryLabels;
  onWorkspace(): void;
  status?: ReactNode;
}) {
  const history = useConversationHistory(reader);
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
      {history.failed && (
        <p role="alert" className="px-4">
          {labels.unavailable}
        </p>
      )}
      <div className="grid min-h-0 flex-1 gap-4 p-4 md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
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
                      onClick={() => void history.open(item.session, version)}
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
