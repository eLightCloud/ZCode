import { logger } from "@/logger.js";
import { ConversationInlineContinuation } from "./ConversationInlineContinuation.js";
import { useEffect, useRef, useState } from "react";
import type {
  ConversationHistoryReader,
  ConversationHistoryItem,
  ConversationTranscript,
} from "@zcode/shared";
import { Message, MessageContent } from "@/components/ai-elements/message.js";
import { Button } from "@/components/ui/button.js";

/** A conflict is a conversation interaction, not a version-management page. */
export function ConversationConflictChoice({
  reader,
  item,
  chinese,
  onChoose,
}: {
  reader: ConversationHistoryReader;
  item: ConversationHistoryItem;
  chinese: boolean;
  onChoose(copy: ConversationTranscript): void;
}) {
  const [copies, setCopies] = useState<ConversationTranscript[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const signature = JSON.stringify(item.candidates);
  useEffect(() => {
    const controller = new AbortController();
    setCopies([]);
    setFailed(false);
    void Promise.all(
      item.candidates.map((version) => reader.transcript(item.session, version, controller.signal)),
    )
      .then((values) => {
        if (controller.signal.aborted) return;
        if (
          values.some(
            (value, index) =>
              !value || value.session !== item.session || value.version !== item.candidates[index],
          )
        )
          throw new Error("conversation_copies_unconfirmed");
        setCopies(values as ConversationTranscript[]);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCopies([]);
          setFailed(true);
          logger.warn("conversation.conflict.read", {
            sessionId: item.session,
            outcome: "unconfirmed",
          });
        }
      });
    return () => controller.abort();
  }, [reader, item.session, signature, attempt]);
  return (
    <Message from="assistant">
      <MessageContent>
        <p>
          {chinese
            ? "这段会话在不同位置有了不同的更新。请选择接下来沿用哪份内容；其它记录仍会保留，已经执行的业务操作不会撤销。"
            : "This conversation has different updates in different places. Choose the content to continue from. Other copies remain, and completed business actions are not undone."}
        </p>
        <div
          role="group"
          aria-label={chinese ? "选择会话内容" : "Choose conversation content"}
          className="max-h-80 space-y-3 overflow-auto"
        >
          {copies.map((copy) => (
            <div key={copy.version} className="rounded-lg border border-border p-3">
              <p className="line-clamp-4 whitespace-pre-wrap text-ui-base">
                {copy.deleted
                  ? chinese
                    ? "这份记录已删除"
                    : "This copy was deleted"
                  : copy.messages.at(-1)?.text || copy.title}
              </p>
              <Button variant="outline" className="mt-2" onClick={() => onChoose(copy)}>
                {copy.deleted
                  ? chinese
                    ? "保留删除状态"
                    : "Keep deleted"
                  : chinese
                    ? "使用这份内容"
                    : "Use this content"}
              </Button>
            </div>
          ))}
          {failed ? (
            <>
              <p role="alert">
                {chinese
                  ? "暂时无法核对不同内容，尚未作出选择。"
                  : "The copies could not be checked. Nothing has been selected."}
              </p>
              <Button variant="ghost" onClick={() => setAttempt(attempt + 1)}>
                {chinese ? "重试" : "Retry"}
              </Button>
            </>
          ) : (
            !copies.length && (
              <p role="status">
                {chinese ? "正在核对不同内容…" : "Checking the different copies…"}
              </p>
            )
          )}
        </div>
      </MessageContent>
    </Message>
  );
}

/** Live native sessions resolve their conflict in-place through the same native continuation owner. */
export function ConversationConflict({
  reader,
  history,
  session,
  chinese,
  getLocation,
  onResolved,
}: {
  reader: ConversationHistoryReader;
  history: ReturnType<typeof import("../hooks/useConversationHistory.js").useConversationHistory>;
  session: string;
  chinese: boolean;
  getLocation(): Promise<string>;
  onResolved?(): void;
}) {
  const item = history.items.find((row) => row.session === session);
  const [choice, setChoice] = useState<{
    version: string;
    location: string;
    candidates: readonly string[];
  }>();
  const [failure, setFailure] = useState(false);
  const [deletion, setDeletion] = useState<string>();
  const deletionStarted = useRef(false);
  useEffect(() => {
    if (!deletion || history.transcript?.version !== deletion || deletionStarted.current) return;
    deletionStarted.current = true;
    void history.chooseDeletion();
  }, [deletion, history]);
  if (!item || item.candidates.length < 2) return null;
  if (choice)
    return (
      <Message from="assistant">
        <MessageContent>
          <ConversationInlineContinuation
            reader={reader}
            session={session}
            version={choice.version}
            preferredLocation={choice.location}
            expectedCandidates={choice.candidates}
            chinese={chinese}
            onChanged={() => {
              setChoice(undefined);
              void history.refresh();
            }}
            onCancelled={() => setChoice(undefined)}
            onReady={() => {
              setChoice(undefined);
              onResolved?.();
            }}
          />
        </MessageContent>
      </Message>
    );
  return (
    <div className="space-y-2">
      {!deletion && (
        <ConversationConflictChoice
          reader={reader}
          item={item}
          chinese={chinese}
          onChoose={async (copy) => {
            setFailure(false);
            if (copy.deleted) {
              setDeletion(copy.version);
              void history.open(session, copy.version);
              return;
            }
            try {
              setChoice({
                version: copy.version,
                location: await getLocation(),
                candidates: [...item.candidates],
              });
            } catch {
              logger.warn("conversation.conflict.location", {
                sessionId: session,
                outcome: "unconfirmed",
              });
              setFailure(true);
            }
          }}
        />
      )}
      {deletion && (
        <p role={history.choiceError ? "alert" : "status"}>
          {history.choiceDone
            ? chinese
              ? "已保留删除状态。"
              : "Kept deleted."
            : history.choiceError
              ? chinese
                ? "尚未确认删除选择，请重新核对。"
                : "The deletion choice is unconfirmed. Review again."
              : chinese
                ? "正在确认删除选择…"
                : "Confirming the deletion choice…"}
        </p>
      )}
      {failure && (
        <p role="alert">
          {chinese
            ? "当前位置暂时无法确认，尚未更改会话。请稍后重新选择。"
            : "The current location is unconfirmed. The conversation is unchanged; choose again shortly."}
        </p>
      )}
    </div>
  );
}
