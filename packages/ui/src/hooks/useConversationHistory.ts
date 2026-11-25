import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConversationHistoryItem,
  ConversationHistoryReader,
  ConversationContinuationOptions,
  ConversationTranscript,
  ConversationDeletionChoice,
} from "@zcode/shared";
import { ConversationChoiceError } from "@zcode/shared";

/** 普通追加保存会推进唯一候选；已选基线只在接纳或交接时推进。 */
export function savedConversationVersion(item: ConversationHistoryItem) {
  return item.candidates.length === 1 ? item.candidates[0] : (item.version ?? item.candidates[0]);
}

/** Ephemeral read projection. No runtime, accepted queue or activation state lives here. */
export function useConversationHistory(
  reader: ConversationHistoryReader,
  follow?: {
    session: string;
    onOptions?(options: ConversationContinuationOptions): void;
  },
) {
  const [items, setItems] = useState<ConversationHistoryItem[]>([]);
  const [followedItem, setFollowedItem] = useState<ConversationHistoryItem | null>(null);
  const [candidatesChanged, setCandidatesChanged] = useState(false);
  const [transcript, setTranscript] = useState<ConversationTranscript | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [hasMore, setHasMore] = useState(false);
  const [choiceError, setChoiceError] = useState<ConversationChoiceError["code"] | null>(null);
  const [choiceDone, setChoiceDone] = useState(false);
  const choice = useRef<ConversationDeletionChoice | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const pinned = useRef(false);
  const observed = useRef<ConversationTranscript | null>(null);
  observed.current = transcript;
  const followed = follow?.session;
  const viewedItem = useRef<ConversationHistoryItem | null>(null);
  viewedItem.current = followedItem;
  const onOptions = useRef(follow?.onOptions);
  onOptions.current = follow?.onOptions;
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
        setFollowedItem(null);
        setTranscript(null);
        setFailure(error);
      }
    } finally {
      if (owner === generation.current) {
        request.current = null;
        setLoading(false);
      }
    }
  }, []);
  // 原执行端关闭后仍按准确会话读取中心；选中行可能不在目录第一页。
  const readFollowed = useCallback(
    (force = false) =>
      run(async (signal) => {
        if (!followed || !reader.continuation) return;
        const options = await reader.continuation.options(followed, signal);
        if (signal.aborted) return;
        if (options.session !== followed || !options.candidates.length)
          throw new ConversationChoiceError("unavailable");
        if (
          !force &&
          pinned.current &&
          observed.current?.session === followed &&
          viewedItem.current
        ) {
          const reviewed = viewedItem.current.candidates;
          setCandidatesChanged(
            reviewed.length !== options.candidates.length ||
              reviewed.some((version) => !options.candidates.includes(version)),
          );
          return;
        }
        setCandidatesChanged(false);
        const versions = options.candidates;
        let row: ConversationHistoryItem | undefined;
        if (versions.length > 1) {
          // 分歧与删除决定必须沿用中心真实的 selected 和管理事实。
          let after = "";
          for (;;) {
            const page = await reader.history(after, signal);
            if (signal.aborted) return;
            row = page.find((entry) => entry.session === followed);
            if (row) {
              if (
                row.candidates.length !== versions.length ||
                row.candidates.some((v) => !versions.includes(v))
              )
                throw new ConversationChoiceError("stale");
              break;
            }
            const last = page.at(-1)?.session;
            if (page.length !== 50 || !last || last <= after || last >= followed)
              throw new ConversationChoiceError("unavailable");
            after = last;
          }
        }
        const version = row ? savedConversationVersion(row) : versions[0];
        if (!version) throw new ConversationChoiceError("unavailable");
        const prior = observed.current;
        const content =
          prior?.session === followed && prior.version === version
            ? prior
            : await reader.transcript(followed, version, signal);
        if (signal.aborted) return;
        if (!content || content.session !== followed || content.version !== version)
          throw new ConversationChoiceError("unavailable");
        setTranscript(content);
        // 精确打开可能位于下一页；分页游标只由原目录列表推进。
        setFollowedItem(
          row ?? {
            session: followed,
            title: content.title,
            version,
            candidates: versions,
            revision: options.revision,
            selected: null,
            management: null,
          },
        );
        onOptions.current?.(options);
      }),
    [followed, reader, run],
  );
  const refresh = useCallback(
    () =>
      followed
        ? readFollowed(true)
        : run(async (signal) => {
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
    [reader, run, followed, readFollowed],
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
    const item =
      followedItem?.session === transcript.session
        ? followedItem
        : items.find((item) => item.session === transcript.session);
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
    pinned.current = false;
    void refresh();
    const focus = () => {
      if (document.visibilityState === "hidden") return;
      if (followed && request.current) return;
      if (followed) void readFollowed();
      else void refresh();
    };
    globalThis.addEventListener("focus", focus);
    if (followed) document.addEventListener("visibilitychange", focus);
    const timer = followed ? setInterval(focus, 15000) : undefined;
    return () => {
      ++generation.current;
      request.current?.abort();
      globalThis.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      clearInterval(timer);
    };
  }, [refresh, followed, readFollowed]);
  useEffect(() => {
    // 查看及确认期间固定所见候选；新版本由服务端 CAS 拒绝，不能后台替换确认基线。
    if (followed || loading || transcript || choice.current) return;
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
  }, [reader, loading, transcript, followed]);
  return {
    candidatesChanged,
    pinCurrentRead: useCallback((value: boolean) => {
      pinned.current = value;
    }, []),
    items:
      followedItem && followedItem.session === followed
        ? [...items.filter((item) => item.session !== followed), followedItem]
        : items,
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
      request.current = null;
      setFollowedItem(null);
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
