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
  const [failure, setFailure] = useState<unknown>(null);
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
    setFailure(null);
    setLoading(true);
    try {
      await read(current.signal);
    } catch (error) {
      if (owner === generation.current && !current.signal.aborted) {
        // 账号撤销、超时和未知结果都不能继续显示另一身份的缓存正文。
        setItems([]);
        setTranscript(null);
        setFailure(error);
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
  useEffect(() => {
    // 查看及确认期间固定所见候选；新版本由服务端 CAS 拒绝，不能后台替换确认基线。
    if (loading || transcript || choice.current) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      // 空 cursor 保留 reader 已绑定的身份；不能后台重置 scope 后继续展示旧正文。
      await reader
        .history("", controller.signal)
        .then((rows) => {
          if (!controller.signal.aborted) {
            setFailure(null);
            setItems((old) => [
              ...rows,
              ...old.filter((row) => !rows.some((next) => next.session === row.session)),
            ]);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setItems([]);
            setTranscript(null);
            setFailure(error);
          }
        });
      if (!controller.signal.aborted)
        timer = setTimeout(() => {
          void poll();
        }, 15000);
    };
    timer = setTimeout(() => {
      void poll();
    }, 15000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [reader, loading, transcript]);
  return {
    items,
    transcript,
    loading,
    failed: failure !== null,
    failure,
    hasMore,
    refresh,
    more,
    close: () => {
      ++generation.current;
      request.current?.abort();
      setTranscript(null);
      setLoading(false);
      choice.current = null;
      setChoiceError(null);
    },
    open,
    choiceError,
    choiceDone,
    chooseDeletion,
    canRetryChoice: choice.current !== null && choiceError === "unavailable",
    retryChoice: () => (choice.current ? commitChoice(choice.current) : undefined),
  };
}
