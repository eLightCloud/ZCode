import { logger } from "@/logger.js";
import { useEffect, useRef, useState } from "react";
import type { ConversationHistoryReader } from "@zcode/shared";
import { useConversationContinuation } from "../hooks/useConversationContinuation.js";
import { Button } from "@/components/ui/button.js";

/** Presentation and explicit intent only; the existing continuation hook owns operation recovery. */
export function ConversationInlineContinuation({
  reader,
  session,
  version,
  chinese,
  onReady,
  expectedCandidates,
  onChanged,
  onCancelled,
  preferredLocation,
}: {
  reader: ConversationHistoryReader;
  session: string;
  version: string;
  chinese: boolean;
  expectedCandidates?: readonly string[];
  onChanged?(): void;
  onCancelled?(): void;
  preferredLocation?: string;
  onReady(session: string, location: string, instance?: string): void | Promise<void>;
}) {
  const state = useConversationContinuation(reader, session);
  const [target, setTarget] = useState<string>();
  const [offline, setOffline] = useState(false);
  const [requestOffline, setRequestOffline] = useState(false);
  const [navigationError, setNavigationError] = useState(false);
  const prepared = useRef(false);
  const opened = useRef(false);
  const options = state.options;
  const active = options?.active;
  const direct =
    !preferredLocation &&
    !offline &&
    options?.candidates.length === 1 &&
    !options.pending &&
    !options.inflight &&
    !["requested", "granted"].includes(options.handoff?.phase ?? "")
      ? options.targets.find((row) => row.location === active?.location)
      : undefined;
  const selected =
    options?.targets.find((row) => row.location === (preferredLocation ?? target)) ??
    (!preferredLocation && !active && options?.targets.length === 1
      ? options.targets[0]
      : undefined);
  const changed = Boolean(
    state.options &&
    (!state.options.candidates.includes(version) ||
      (expectedCandidates &&
        JSON.stringify([...state.options.candidates].sort()) !==
          JSON.stringify([...expectedCandidates].sort()))),
  );
  useEffect(() => {
    if (
      state.busy ||
      state.error ||
      state.pending ||
      state.result ||
      !state.options ||
      changed ||
      direct
    )
      return;
    if (
      !preferredLocation &&
      !state.options.targets.length &&
      reader.continuation?.prepareTarget &&
      !prepared.current
    ) {
      prepared.current = true;
      void state.prepareTarget();
    } else if (selected) {
      // 唯一目标沿已确认版本接续；跨位置在线来源先交接，不能用离线分支偷偷接管。
      const handoff =
        !offline &&
        state.options.candidates.length === 1 &&
        active &&
        active.location !== selected.location;
      // 读的是最新保存正文，交接必须以当前代次获准的基线开始，源端会在屏障内捕获最终正文。
      void state.start(
        offline ? "offline" : handoff ? "handoff" : "select",
        selected.location,
        handoff ? active.version : version,
      );
    }
  });
  useEffect(() => {
    const result = state.result;
    if (result?.status === "cancelled") {
      if (requestOffline) {
        setOffline(true);
        setRequestOffline(false);
        void state.refresh();
      } else onCancelled?.();
      return;
    }
    if (opened.current || state.busy || state.error) return;
    const exact =
      result?.status === "ready"
        ? options?.targets.find((row) => row.location === result.location)
        : !changed && !result && !state.pending
          ? direct
          : undefined;
    if (!exact) return;
    opened.current = true;
    void Promise.resolve(onReady(session, exact.location, exact.instanceId)).catch(() => {
      logger.warn("conversation.navigation", { sessionId: session, outcome: "unavailable" });
      setNavigationError(true);
    });
  });
  useEffect(() => {
    if (
      state.busy ||
      state.error ||
      (state.result?.reason !== "busy" &&
        state.result?.status !== "forward_only" &&
        state.result?.status !== "cancelling")
    )
      return;
    const timer = setTimeout(() => {
      void state.retry();
    }, 2000);
    return () => clearTimeout(timer);
  }, [state.result, state.busy, state.error, state.retry]);
  const reason = state.result?.reason;
  const needsReview =
    changed || state.result?.status === "stale" || reason === "changed" || state.error === "stale";
  const choosingTarget =
    !preferredLocation &&
    !state.busy &&
    !state.pending &&
    !state.error &&
    !state.result &&
    !direct &&
    !selected &&
    !changed &&
    Boolean(options?.targets.length);
  const missingTarget = Boolean(
    options &&
    (preferredLocation
      ? !selected
      : !options.targets.length && !reader.continuation?.prepareTarget),
  );
  const canOfferOffline =
    reason === "unavailable" &&
    Boolean(state.options?.active) &&
    !offline &&
    state.result?.phase !== "granted" &&
    state.result?.status !== "forward_only";
  const message = missingTarget
    ? chinese
      ? "当前位置暂时无法继续，请稍后重试。会话尚未更改。"
      : "The current location cannot continue yet. Retry shortly. The conversation is unchanged."
    : needsReview
      ? chinese
        ? "会话又有了更新，请重新查看最新内容后选择。输入仍保留。"
        : "The conversation changed again. Review the latest content before choosing. Your draft is retained."
      : navigationError
        ? chinese
          ? "会话已准备好，但暂时无法打开。输入仍保留，请重试。"
          : "The conversation is ready but could not open. Your draft is retained. Retry."
        : reason === "model"
          ? chinese
            ? "当前环境不能使用原来的模型，请先在模型设置中修复，再重试。输入尚未发送。"
            : "The original model is unavailable. Repair it in model settings and retry. Your input has not been sent."
          : reason === "required_skill"
            ? chinese
              ? "这段会话需要的场景尚未就绪，请先补齐原场景。输入尚未发送。"
              : "The required scenario is not ready. Restore it before retrying. Your input has not been sent."
            : reason === "files"
              ? chinese
                ? "所需文件还未完整同步，请恢复文件后重试。输入尚未发送。"
                : "Required files are not fully saved. Restore them and retry. Your input has not been sent."
              : state.error || reason === "unavailable" || reason === "capability"
                ? chinese
                  ? "暂时无法确认会话状态，请稍后重试。输入仍保留，尚未发送。"
                  : "Conversation status is unconfirmed. Retry shortly. Your draft is retained and has not been sent."
                : reason === "busy"
                  ? chinese
                    ? "原位置还有工作正在完成，我会等待它结束。输入尚未发送。"
                    : "Work at the original location is still finishing. Your input has not been sent."
                  : chinese
                    ? "正在准备继续这段会话，输入尚未发送。"
                    : "Preparing to continue this conversation. Your input has not been sent.";
  return (
    <div className="space-y-3 text-ui-base" aria-busy={state.busy}>
      {!choosingTarget && (
        <p role={state.error || navigationError ? "alert" : "status"}>{message}</p>
      )}
      {needsReview && (
        <Button variant="outline" onClick={onChanged}>
          {chinese ? "查看最新内容" : "Review latest content"}
        </Button>
      )}
      {choosingTarget && (
        <div
          role="group"
          aria-label={chinese ? "选择继续位置" : "Choose where to continue"}
          className="flex flex-wrap gap-2"
        >
          <p className="w-full">
            {chinese ? "你希望在哪里继续？" : "Where would you like to continue?"}
          </p>
          {state.options!.targets.map((row) => (
            <Button key={row.location} variant="outline" onClick={() => setTarget(row.location)}>
              {active && active.location !== row.location
                ? chinese
                  ? `在${row.label}继续`
                  : "Continue on " + row.label
                : row.label}
            </Button>
          ))}
        </div>
      )}
      {!needsReview &&
        !canOfferOffline &&
        !state.busy &&
        (state.error || state.pending || state.result || navigationError || missingTarget) && (
          <Button
            variant="outline"
            onClick={() => {
              if (navigationError) {
                opened.current = false;
                setNavigationError(false);
              } else {
                prepared.current = false;
                void state.retry();
              }
            }}
          >
            {chinese ? "重试" : "Retry"}
          </Button>
        )}
      {!canOfferOffline &&
        !state.busy &&
        state.pending &&
        state.result?.phase !== "granted" &&
        !["ready", "forward_only"].includes(state.result?.status ?? "") && (
          <Button variant="ghost" onClick={() => void state.cancel()}>
            {chinese ? "取消" : "Cancel"}
          </Button>
        )}
      {!state.busy && !state.pending && state.error && onCancelled && (
        <Button variant="ghost" onClick={onCancelled}>
          {chinese ? "返回编辑" : "Back to editing"}
        </Button>
      )}
      {!state.busy && canOfferOffline && (
        <div className="space-y-2">
          <p>
            {chinese
              ? "原设备可能仍在运行。如果仍选择在这里继续，会保留独立记录；已有业务操作不会撤销。"
              : "The original device may still be running. Continuing here keeps a separate copy and does not undo business actions."}
          </p>
          <Button variant="ghost" onClick={() => void state.retry()}>
            {chinese ? "等待原位置" : "Wait for the original location"}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setRequestOffline(true);
              void state.cancel();
            }}
          >
            {chinese ? "仍在这里继续" : "Continue here anyway"}
          </Button>
        </div>
      )}
    </div>
  );
}
