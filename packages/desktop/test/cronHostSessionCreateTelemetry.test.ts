import { describe, expect, it } from "vitest";
import { reportHostSessionCreate } from "../src/host/hostSessionCreateTelemetry.js";
import type { TraceId } from "@zcode/shared";

describe("automation session creation host adapter", () => {
  it("forwards native session attribution to the existing host telemetry channel", () => {
    const messages: unknown[] = [];
    reportHostSessionCreate({ postMessage: (message: unknown) => messages.push(message) }, {
      sessionId: "native-session", messageId: "automation:1000" as TraceId,
      source: "automation_scheduled", workspaceIdentity: "workspace-identity",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ event: { talkId: "native-session",
      messageId: "automation:1000", eventExtraDetail: { create_source: "automation_scheduled" } } });
  });
});
