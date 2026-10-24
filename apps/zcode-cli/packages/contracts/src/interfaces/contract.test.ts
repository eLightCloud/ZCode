import { describe, expect, it } from "vitest";
import { inheritPermissionMode } from "./session.port.js";
import { portableAttachmentRef } from "./text-input-facts.js";

describe("native execution protocol contract", () => {
  it("keeps derived YOLO work inside its guarded parent's authority", () => {
    expect(inheritPermissionMode("guarded", "yolo")).toBe("guarded");
    expect(inheritPermissionMode("guarded", "build")).toBe("build");
  });
  it("rejects local file paths as portable synchronization attachments", () => {
    expect(
      portableAttachmentRef.safeParse({
        ref: "file:///tmp/private.txt",
        fileName: "private.txt",
        mime: "text/plain",
        bytes: 1,
      }).success,
    ).toBe(false);
  });
});
