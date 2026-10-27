import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import type { NativeDeliverable } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

export interface ApplicationShareCandidate {
  title: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/** Trusted optional assembly; owns no session, credential or publication facts. */
export interface ApplicationPeripherals {
  nativeCloudEnabled: boolean;
  renderConversationContent?: (
    context: Pick<import("./ApplicationPages.js").ApplicationPageContext, "openConversation">,
  ) => ReactNode;
  closeConversationContent?: () => void;
  renderConversationList?: (nativeSessionIds: readonly string[]) => ReactNode;
  /** Compact decoration in the task title row; never a second text row or navigation. */
  renderConversationListStatus?: (sessionId: string) => ReactNode;
  renderConversationStatus?: (context: { sessionId: string; workspacePath: string }) => ReactNode;
  renderDeliverables?: (files: readonly NativeDeliverable[], workspacePath: string) => ReactNode;
  openHelp: () => void;
  openFeedback: () => void;
  openShare: (candidate: ApplicationShareCandidate) => void;
  renderAutomationSupplement?: () => ReactNode;
  renderModelPlans: () => ReactNode;
}

const Context = createContext<ApplicationPeripherals | undefined>(undefined);
export function ApplicationPeripheralsProvider({
  value,
  children,
}: {
  value?: ApplicationPeripherals;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!value) return;
    // 错误面等旧原生入口仍发出 store 命令；只转交动作，不带自动日志或会话草稿。
    const redirect = () => {
      const state = useFeedbackStore.getState();
      if (!state.open && !state.featureRequestOpen) return;
      state.close();
      value.openFeedback();
    };
    const unsubscribe = useFeedbackStore.subscribe(redirect);
    redirect();
    return unsubscribe;
  }, [value]);
  return <Context value={value}>{children}</Context>;
}
export function useApplicationPeripherals() {
  return useContext(Context);
}

export function applicationShareCandidate(
  title: string,
  rows: readonly ConversationRow[],
): ApplicationShareCandidate {
  return {
    title,
    messages: rows.flatMap((row) => {
      if (row.kind !== "userInput" && row.kind !== "assistantText") return [];
      if (row.kind === "assistantText" && row.state !== "complete") return [];
      if (row.kind === "userInput" && row.origin !== "realUser") return [];
      return [
        {
          role: row.kind === "userInput" ? ("user" as const) : ("assistant" as const),
          content:
            row.kind === "userInput" && row.epilogueStart !== undefined
              ? row.text.slice(0, row.epilogueStart)
              : row.text,
        },
      ];
    }),
  };
}
