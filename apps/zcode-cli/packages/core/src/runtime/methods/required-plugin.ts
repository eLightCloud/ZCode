import { modelMessageContentToText } from "@zcode/contracts";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import {
  CoreErrorType,
  createCoreError,
  createMessageId,
  traceContextToLogContext,
} from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isValidPluginStableId } from "../../plugin-reference/index.js";
import { renderSkillContent } from "../../tool/handlers/skill.js";

const PREFIX = "Required plugin entry: ";
const DESTINATIONS = /\[(?:\\.|[^\\\]])*\]\((?:<([^>]+)>|([^\s)]+))\)/g;

/** Explicit canonical reference; labels and ordinary text grant no capabilities. */
export function requiredPluginSelection(text: string): string | null | undefined {
  const values: (string | null)[] = [];
  for (const match of text.matchAll(DESTINATIONS)) {
    const destination = match[1] ?? match[2] ?? "";
    if (!destination.startsWith("required-plugin://")) continue;
    const id = destination.slice("required-plugin://".length);
    if (id !== "none" && !isValidPluginStableId(id))
      throw new Error("required_skill.invalid_reference");
    values.push(id === "none" ? null : id);
  }
  if (values.length > 1) throw new Error("required_skill.ambiguous_reference");
  return values[0];
}

export function requiredPluginFromHistory(
  entries: readonly RuntimeMessageEntry[],
): string | null | undefined {
  return requiredPluginFromFacts(
    entries.map((entry) =>
      entry.kind === "attachment"
        ? {
            text: entry.content,
            pluginReference: entry.metadata.source === "plugin_reference",
            realUser: false,
          }
        : {
            text: modelMessageContentToText(entry.message.content),
            pluginReference: false,
            realUser: entry.message.role === "user" && entry.metadata?.source === "real_user",
          },
    ),
  );
}

export function requiredPluginFromFacts(
  facts: readonly { text: string; realUser: boolean; pluginReference: boolean }[],
): string | null | undefined {
  for (const fact of facts.toReversed()) {
    if (fact.realUser) {
      const selected = requiredPluginSelection(fact.text);
      if (selected !== undefined) return selected;
    } else if (fact.pluginReference && fact.text.startsWith(PREFIX)) {
      const value = fact.text.slice(PREFIX.length).split("\n", 1)[0]!;
      if (value !== "none" && !isValidPluginStableId(value))
        throw new Error("required_skill.invalid_reference");
      return value === "none" ? null : value;
    }
  }
  return undefined;
}

/** Preserve the selected entry through native compact persistence, without another state store. */
export function requiredPluginCompactReminder(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[] {
  const pluginId = requiredPluginFromHistory(entries);
  if (pluginId === undefined) return [];
  const header = PREFIX + (pluginId ?? "none");
  const loaded = entries.findLast(
    (entry) =>
      entry.kind === "attachment" &&
      entry.metadata.source === "plugin_reference" &&
      entry.content.split("\n", 1)[0] === header,
  );
  return [loaded ?? systemReminderAttachmentEntry("plugin_reference", header)];
}

export async function enforceRequiredPluginEntry(
  runtime: AgentRuntimeInternal,
  canonicalInput: string,
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<void> {
  const selection = requiredPluginSelection(canonicalInput);
  const pluginId =
    selection === undefined
      ? requiredPluginFromHistory(runtime.messageHistory.borrowReadOnlyRuntimeEntries())
      : selection;
  if (pluginId === undefined) return;
  signal?.throwIfAborted();
  let text = PREFIX + "none";
  if (pluginId !== null) {
    const load = runtime.skillPort?.loadRequiredPluginSkill;
    if (!load)
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "Required plugin entry is unavailable",
        { recoverable: true },
      );
    try {
      const loaded = await load.call(
        runtime.skillPort,
        {
          pluginId,
          workingDirectory: runtime.workingDirectory,
          maxBytes: 100_000,
          trace,
        },
        { signal },
      );
      text = PREFIX + pluginId + "\n" + renderSkillContent(loaded);
      runtime.logger?.info("Required plugin skill loaded", {
        ...traceContextToLogContext(trace),
        event: "required_skill.loaded",
        pluginId,
      });
    } catch {
      signal?.throwIfAborted();
      runtime.logger?.warn("Required plugin skill rejected", {
        ...traceContextToLogContext(trace),
        event: "required_skill.rejected",
        pluginId,
      });
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "Required plugin entry is unavailable; repair the selected plugin before retrying",
        { recoverable: true },
      );
    }
  }
  signal?.throwIfAborted();
  const previous = runtime.messageHistory
    .borrowReadOnlyRuntimeEntries()
    .findLast(
      (entry) =>
        entry.kind === "attachment" &&
        entry.metadata.source === "plugin_reference" &&
        entry.content.startsWith(PREFIX),
    );
  if (previous?.kind === "attachment" && previous.content === text) return;
  runtime.messageHistory.addAttachment("plugin_reference", text);
  await runtime.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: runtime.sessionId,
    source: "plugin_reference",
    text,
    traceContext: trace,
  });
}
