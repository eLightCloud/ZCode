import { useEffect, useRef } from "react";
import { useApplicationPageNavigationState } from "@/root/ApplicationPageNavigation.js";

/** Consumes one trusted open intent per token; unknown or dialog pages are ignored. */
export function ApplicationPageIntentBridge({
  intent,
  onConsumed,
}: {
  intent?: { pageId: string; token: number } | null;
  onConsumed?: () => void;
}) {
  const navigation = useApplicationPageNavigationState();
  const consumed = useRef<number>(0);
  useEffect(() => {
    if (!intent || intent.token === consumed.current) return;
    consumed.current = intent.token;
    const registered = navigation?.sidebarPages.some((page) => page.id === intent.pageId);
    if (registered) navigation?.openPage(intent.pageId);
    onConsumed?.();
  }, [intent, navigation, onConsumed]);
  return null;
}
