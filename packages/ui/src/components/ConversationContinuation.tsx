import { useState } from "react";
import type { ConversationHistoryReader, ConversationContinuationIntent } from "@zcode/shared";
import { useConversationContinuation } from "../hooks/useConversationContinuation.js";
import { Button } from "./ui/button.js";

export interface ConversationContinuationLabels {
  target: string;
  prepareTarget: string;
  choose: string;
  handoff: string;
  offline: string;
  warning: string;
  offlineWarning: string;
  confirm: string;
  back: string;
  retry: string;
  cancel: string;
  open: string;
  loading: string;
  unavailable: string;
  waiting: string;
  busy: string;
  stale: string;
  ready: string;
  cancelled: string;
  forwardOnly: string;
  cancelling: string;
}
export function ConversationContinuation({
  reader,
  session,
  version,
  labels,
  onReady,
}: {
  reader: ConversationHistoryReader;
  session: string;
  version: string;
  labels: ConversationContinuationLabels;
  onReady?(session: string, location: string, instanceId: string): void;
}) {
  const state = useConversationContinuation(reader, session);
  const [target, setTarget] = useState("");
  const [confirm, setConfirm] = useState<ConversationContinuationIntent["kind"] | null>(null);
  const options = state.options,
    selected = options?.targets.find((value) => value.location === target) ?? options?.targets[0];
  const readyTarget = options?.targets.find((value) => value.location === state.result?.location);
  const result = state.result;
  const message = state.error
    ? state.error === "stale"
      ? labels.stale
      : labels.unavailable
    : state.busy
      ? labels.loading
      : result?.status === "ready"
        ? labels.ready
        : result?.status === "cancelled"
          ? labels.cancelled
          : result?.status === "cancelling"
            ? labels.cancelling
            : result?.status === "forward_only"
              ? labels.forwardOnly
              : result?.status === "stale"
                ? labels.stale
                : result?.reason === "busy"
                  ? labels.busy
                  : result
                    ? labels.waiting
                    : null;
  return (
    <div
      className="border-border space-y-3 rounded-md border p-3 text-ui-base"
      aria-busy={state.busy}
    >
      {message && <p role={state.error ? "alert" : "status"}>{message}</p>}
      {result?.status === "ready" && readyTarget?.instanceId && onReady && (
        <Button onClick={() => onReady(session, result.location!, readyTarget.instanceId!)}>
          {labels.open}
        </Button>
      )}
      {!state.pending && !state.busy && !["ready", "cancelled"].includes(result?.status ?? "") && (
        <>
          {reader.continuation?.prepareTarget && (
            <Button variant="outline" onClick={() => void state.prepareTarget()}>
              {labels.prepareTarget}
            </Button>
          )}
          <label className="flex flex-col gap-2">
            {labels.target}
            <select
              aria-label={labels.target}
              className="border-input bg-background min-h-11 rounded-md border px-3 text-mobile-input-safe"
              value={selected?.location ?? ""}
              onChange={(event) => {
                setTarget(event.target.value);
                setConfirm(null);
              }}
            >
              {options?.targets.map((value) => (
                <option key={value.location} value={value.location}>
                  {value.label}
                </option>
              ))}
            </select>
          </label>
          {confirm ? (
            <div
              role="group"
              aria-label={labels.confirm}
              className="space-y-3"
              onKeyDown={(event) => {
                if (event.key === "Escape") setConfirm(null);
              }}
            >
              <p>{confirm === "offline" ? labels.offlineWarning : labels.warning}</p>
              <div className="flex flex-wrap gap-3">
                <Button autoFocus variant="outline" onClick={() => setConfirm(null)}>
                  {labels.back}
                </Button>
                <Button
                  disabled={!selected}
                  onClick={() => {
                    if (selected) {
                      void state.start(
                        confirm,
                        selected.location,
                        confirm === "handoff" ? options!.active!.version : version,
                      );
                      setConfirm(null);
                    }
                  }}
                >
                  {labels.confirm}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                disabled={!selected || !options?.candidates.includes(version)}
                onClick={() => setConfirm("select")}
              >
                {labels.choose}
              </Button>
              {options?.active && selected?.location !== options.active.location && (
                <Button variant="outline" onClick={() => setConfirm("handoff")}>
                  {labels.handoff}
                </Button>
              )}
              <Button variant="outline" disabled={!selected} onClick={() => setConfirm("offline")}>
                {labels.offline}
              </Button>
            </div>
          )}
        </>
      )}
      {(state.pending || state.error || result?.status === "cancelled") && (
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" disabled={state.busy} onClick={() => void state.retry()}>
            {labels.retry}
          </Button>
          {state.pending && result?.phase !== "granted" && (
            <Button variant="outline" disabled={state.busy} onClick={() => void state.cancel()}>
              {labels.cancel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
