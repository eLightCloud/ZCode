import { useCallback, useEffect, useRef, useState } from "react";
import {
  ConversationChoiceError,
  type ConversationHistoryReader,
  type ConversationContinuationIntent,
  type ConversationContinuationOptions,
  type ConversationContinuationResult,
  conversationContinuationIntentSchema,
  type ModelSelection,
} from "@zcode/shared";
import { logger } from "../logger.js";

/** Only displays server-confirmed progress. An ambiguous response retains the immutable operation. */
export function useConversationContinuation(reader: ConversationHistoryReader, session: string) {
  const [options, setOptions] = useState<ConversationContinuationOptions | null>(null);
  const [result, setResult] = useState<ConversationContinuationResult | null>(null);
  const [error, setError] = useState<ConversationChoiceError["code"] | null>(null);
  const [busy, setBusy] = useState(false);
  const intent = useRef<ConversationContinuationIntent | null>(null);
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const perform = useCallback(
    async (work: (signal: AbortSignal) => Promise<void>) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      const owner = ++epoch.current;
      setBusy(true);
      setError(null);
      try {
        await work(controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted && owner === epoch.current) {
          const code = cause instanceof ConversationChoiceError ? cause.code : "unavailable";
          setError(code);
          if (code === "scope") {
            setOptions(null);
            setResult(null);
            intent.current = null;
          }
          logger.warn("conversation.continuation.ui", {
            sessionId: session,
            operationId: intent.current?.operation,
            outcome: "unconfirmed",
            code,
          });
        }
      } finally {
        if (owner === epoch.current) setBusy(false);
      }
    },
    [session],
  );
  const refresh = useCallback(
    () =>
      perform(async (signal) => {
        if (!reader.continuation) throw new ConversationChoiceError("blocked");
        const value = await reader.continuation.options(session, signal);
        if (signal.aborted) return;
        setOptions(value);
        intent.current = value.inflight;
        setResult(null);
      }),
    [reader, session, perform],
  );
  useEffect(() => {
    setOptions(null);
    setResult(null);
    intent.current = null;
    void refresh();
    return () => {
      ++epoch.current;
      request.current?.abort();
    };
  }, [refresh]);
  const submit = (input: ConversationContinuationIntent) =>
    perform(async (signal) => {
      if (!reader.continuation) throw new ConversationChoiceError("blocked");
      const value = await reader.continuation.run(input, signal);
      if (signal.aborted) return;
      setResult(value);
      if (["ready", "cancelled"].includes(value.status)) intent.current = null;
    });
  return {
    options,
    result,
    error,
    busy,
    refresh,
    prepareTarget: () =>
      perform(async (signal) => {
        if (!reader.continuation?.prepareTarget) throw new ConversationChoiceError("blocked");
        await reader.continuation.prepareTarget(session, signal);
        const value = await reader.continuation.options(session, signal);
        if (signal.aborted) return;
        setOptions(value);
        intent.current = value.inflight;
        setResult(null);
      }),
    get pending() {
      return intent.current !== null;
    },
    start(
      kind: ConversationContinuationIntent["kind"],
      target: string,
      version: string,
      targetModel?: ModelSelection,
    ) {
      if (!options || intent.current || busy) return;
      const input = conversationContinuationIntentSchema.parse({
        session,
        operation: crypto.randomUUID(),
        kind,
        target,
        version,
        revision: options.revision,
        candidates: [...options.candidates],
        ...(targetModel ? { targetModel } : {}),
      });
      intent.current = input;
      return submit(input);
    },
    retry: () => (intent.current ? submit(intent.current) : refresh()),
    cancel: () =>
      perform(async (signal) => {
        const input = intent.current;
        if (!input || !reader.continuation) return;
        const value = await reader.continuation.cancel(
          { session, operation: input.operation },
          signal,
        );
        if (signal.aborted) return;
        setResult(value);
        if (value.status === "cancelled") intent.current = null;
      }),
  };
}
