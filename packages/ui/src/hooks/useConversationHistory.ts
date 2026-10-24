import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConversationHistoryItem,
  ConversationHistoryReader,
  ConversationTranscript,
  ConversationDeletionChoice,
} from "@zcode/shared";
import { ConversationChoiceError } from "@zcode/shared";

/** Ephemeral read projection. No runtime, accepted queue or activation state lives here. */
export function useConversationHistory(reader: ConversationHistoryReader) {
  const [items, setItems] = useState<ConversationHistoryItem[]>([]);
  const [transcript, setTranscript] = useState<ConversationTranscript | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [choiceError, setChoiceError] = useState<ConversationChoiceError["code"] | null>(null);
  const [choiceDone, setChoiceDone] = useState(false);
  const choice = useRef<ConversationDeletionChoice | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const run = useCallback(async (read: (signal: AbortSignal) => Promise<void>) => {
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    const owner = ++generation.current;
    setFailed(false);
    setLoading(true);
    try {
      await read(current.signal);
    } catch {
      if (owner === generation.current && !current.signal.aborted) {
        // 账号撤销、超时和未知结果都不能继续显示另一身份的缓存正文。
        setItems([]);
        setTranscript(null);
        setFailed(true);
      }
    } finally {
      if (owner === generation.current) setLoading(false);
    }
  }, []);
  const refresh = useCallback(
    () =>
      run(async (signal) => {
        setItems([]);
        setTranscript(null);
        choice.current = null;
        setChoiceError(null);
        setChoiceDone(false);
        const rows = await reader.history(null, signal);
        if (signal.aborted) return;
        setItems(rows);
        setTranscript(null);
        setHasMore(rows.length === 50);
      }),
    [reader, run],
  );
  const more = () =>
    run(async (signal) => {
      const rows = await reader.history(items.at(-1)?.session ?? null, signal);
      if (!signal.aborted) {
        setItems((old) => [
          ...old,
          ...rows.filter((row) => !old.some((item) => item.session === row.session)),
        ]);
        setHasMore(rows.length === 50);
      }
    });
  const open = (session: string, version: string) => {
    choice.current = null;
    setChoiceError(null);
    setChoiceDone(false);
    setTranscript(null);
    return run(async (signal) => {
      const value = await reader.transcript(session, version, signal);
      if (!signal.aborted) setTranscript(value);
    });
  };
  const commitChoice = (input: ConversationDeletionChoice) =>
    run(async (signal) => {
      if (!reader.chooseDeletion) throw new ConversationChoiceError("blocked");
      setChoiceError(null);
      setChoiceDone(false);
      try {
        await reader.chooseDeletion(input, signal);
        if (signal.aborted) return;
        const rows = await reader.history(null, signal);
        if (signal.aborted) return;
        choice.current = null;
        setItems(rows);
        setHasMore(rows.length === 50);
        setTranscript(null);
        setChoiceDone(true);
      } catch (error) {
        if (signal.aborted) return;
        const code = error instanceof ConversationChoiceError ? error.code : "unavailable";
        if (code !== "unavailable") choice.current = null;
        setChoiceError(code);
        throw error;
      }
    });
  const chooseDeletion = () => {
    if (!transcript?.deleted || !reader.chooseDeletion) return;
    const item = items.find((item) => item.session === transcript.session);
    if (!item || !item.candidates.includes(transcript.version)) return;
    const input = {
      operation: crypto.randomUUID(),
      session: item.session,
      version: transcript.version,
      candidates: [...item.candidates],
      revision: item.revision,
    };
    choice.current = input;
    return commitChoice(input);
  };
  useEffect(() => {
    void refresh();
    const focus = () => {
      void refresh();
    };
    globalThis.addEventListener("focus", focus);
    return () => {
      ++generation.current;
      request.current?.abort();
      globalThis.removeEventListener("focus", focus);
    };
  }, [refresh]);
  return {
    items,
    transcript,
    loading,
    failed,
    hasMore,
    refresh,
    more,
    open,
    choiceError,
    choiceDone,
    chooseDeletion,
    canRetryChoice: choice.current !== null && choiceError === "unavailable",
    retryChoice: () => (choice.current ? commitChoice(choice.current) : undefined),
  };
}
