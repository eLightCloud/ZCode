import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { ConversationConflictChoice } from "./ConversationConflictChoice.js";
import { useEffect, useRef, useState } from "react";
import type { ConversationHistoryReader } from "@zcode/shared";
import type { useConversationHistory } from "../hooks/useConversationHistory.js";
import { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { Button } from "@/components/ui/button.js";
import { ConversationInlineContinuation } from "./ConversationInlineContinuation.js";

/** Saved content is a native message projection, never a second session or accepted input queue. */
export function SavedConversationThread({
  reader,
  history,
  session,
  chinese,
  failureMessage,
  onReady,
  status,
  files,
  initialDraft,
  onDraftChange,
}: {
  reader: ConversationHistoryReader;
  history: ReturnType<typeof useConversationHistory>;
  session: string;
  initialDraft?: string;
  onDraftChange?(text: string): void;
  chinese: boolean;
  failureMessage: string;
  status?: React.ReactNode;
  files?: React.ReactNode;
  onReady(
    session: string,
    location: string,
    instance?: string,
    draft?: string,
  ): void | Promise<void>;
}) {
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const item = history.items.find((item) => item.session === session);
  const viewed = history.transcript?.session === session ? history.transcript : null;
  const [draft, setDraft] = useState(initialDraft ?? "");
  const [requested, setRequested] = useState(false);
  const requestedCandidates = useRef<readonly string[] | undefined>(undefined);
  const [approved, setApproved] = useState<string>();
  const signature = JSON.stringify(item?.candidates ?? []);
  const approvedCandidates = useRef<string | undefined>(undefined);
  const draftText = useRef(draft);
  draftText.current = draft;
  const conflict = (item?.candidates.length ?? 0) > 1;
  const needsChoice = conflict && (!approved || approvedCandidates.current !== signature);
  const readAttempt = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (history.loading || history.failed || viewed || !item?.version) return;
    const key = item.revision + ":" + item.version;
    if (readAttempt.current === key) return;
    readAttempt.current = key;
    void history.open(session, item.version);
  });
  const reload = () => {
    readAttempt.current = undefined;
    setRequested(false);
    setApproved(undefined);
    void history.refresh();
  };
  return (
    <section
      aria-label={viewed?.title || (chinese ? "会话" : "Conversation")}
      className="@container/conversation flex h-full min-h-0 flex-col"
    >
      <div className="min-h-0 flex-1 overflow-auto px-4 py-6 md:px-8">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          {history.loading && !viewed && (
            <p role="status">{chinese ? "正在读取会话…" : "Loading conversation…"}</p>
          )}
          {history.failed && (
            <div className="space-y-2">
              <p role="alert">{failureMessage}</p>
              <Button variant="ghost" onClick={reload}>
                {chinese ? "重试" : "Retry"}
              </Button>
            </div>
          )}
          {status}
          {viewed?.messages.map((message) => (
            <Message key={message.id} from={message.role}>
              {message.role === "user" ? (
                <ConversationUserInputBubble text={message.text} rowId={message.id} />
              ) : (
                <MessageContent>
                  <MessageResponse theme={theme}>{message.text}</MessageResponse>
                </MessageContent>
              )}
            </Message>
          ))}
          {files}
          {needsChoice && item && (
            <ConversationConflictChoice
              reader={reader}
              item={item}
              chinese={chinese}
              onChoose={(copy) => {
                approvedCandidates.current = signature;
                setApproved(copy.version);
                void history.open(session, copy.version);
              }}
            />
          )}
          {viewed?.deleted && !needsChoice && (
            <Message from="assistant">
              <MessageContent>
                <p>
                  {chinese
                    ? "这份记录已删除。确认后会保留删除状态，其它副本与已有业务效果不变。"
                    : "This copy is deleted. Confirming keeps it deleted; other copies and business effects remain."}
                </p>
                <Button variant="outline" onClick={() => void history.chooseDeletion()}>
                  {chinese ? "确认保留删除状态" : "Keep it deleted"}
                </Button>
                {history.choiceDone && <p role="status">{chinese ? "已确认。" : "Confirmed."}</p>}
              </MessageContent>
            </Message>
          )}
          {requested && !needsChoice && viewed && !viewed.deleted && (
            <Message from="assistant">
              <MessageContent>
                <ConversationInlineContinuation
                  key={session + ":" + viewed.version}
                  reader={reader}
                  session={session}
                  version={approved ?? viewed.version}
                  chinese={chinese}
                  expectedCandidates={requestedCandidates.current}
                  onChanged={reload}
                  onCancelled={() => setRequested(false)}
                  onReady={(id, location, instance) =>
                    onReady(id, location, instance, draftText.current)
                  }
                />
              </MessageContent>
            </Message>
          )}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4 md:px-8">
        <ChatPromptEditor
          workspacePath=""
          taskId={session}
          initialValue={draft}
          onChange={(text) => {
            setDraft(text);
            onDraftChange?.(text);
          }}
          enableMentionPanel={false}
          placeholder={chinese ? "继续这段会话…" : "Continue this conversation…"}
          submitLabel={chinese ? "发送" : "Send"}
          disabled={!viewed || viewed.deleted || history.failed || requested}
          avoidIosInputFocusZoom
          onSubmit={(text) => {
            setDraft(text);
            onDraftChange?.(text);
            draftText.current = text;
            requestedCandidates.current = item ? [...item.candidates] : undefined;
            setRequested(true);
            return false;
          }}
        />
      </div>
    </section>
  );
}
