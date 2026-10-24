import { expect, it } from "vitest";
import { decodePromptAttachmentDataUrl } from "../../src/app/contract.js";
it("keeps attachment decoding bounded and rejects incompatible media", () => {
  expect(decodePromptAttachmentDataUrl("data:text/plain;base64,QQ==", "text/plain", 1)).toEqual({
    bytes: Buffer.from("A"),
    mediaType: "text/plain",
  });
  expect(() =>
    decodePromptAttachmentDataUrl("data:text/plain;base64,QUE=", "text/plain", 1),
  ).toThrow("fault.attachment.previewTooLarge");
  expect(() =>
    decodePromptAttachmentDataUrl("data:text/plain;base64,QQ==", "image/png", 1),
  ).toThrow("fault.attachment.previewNotMedia");
});
