import { useEffect, useReducer, useState } from "react";
import type { AutomationCapabilityReader, AutomationCapabilityState } from "./contract.js";

/** Read-only projection; the selected host remains the single scheduler owner. */
export function useAutomationCapabilities(reader: AutomationCapabilityReader, enabled = true) {
  const [revision, reload] = useReducer((value: number) => value + 1, 0);
  const [snapshot, setSnapshot] = useState<{
    reader: AutomationCapabilityReader;
    revision: number;
    state: AutomationCapabilityState;
  }>();
  useEffect(() => {
    if (!enabled) { setSnapshot(undefined); return; }
    let current = true;
    void reader.getAutomationCapabilities().then(
      (value) => {
        if (current) setSnapshot({ reader, revision, state: { status: "ready", value } });
      },
      () => {
        if (current) setSnapshot({ reader, revision, state: { status: "error" } });
      },
    );
    return () => { current = false; };
  }, [reader, enabled, revision]);
  const state: AutomationCapabilityState = !enabled ? { status: "unavailable" }
    : snapshot?.reader === reader && snapshot.revision === revision ? snapshot.state
    : { status: "loading" };
  return { state, reload };
}

export function formatExecutionTimezone(timezone: string, at = Date.now()): string {
  const offset = new Intl.DateTimeFormat("en", { timeZone: timezone, timeZoneName: "shortOffset" })
    .formatToParts(at).find((part) => part.type === "timeZoneName")?.value.replace(/^GMT[+-]0$/, "GMT");
  return `${timezone} (${offset})`;
}
