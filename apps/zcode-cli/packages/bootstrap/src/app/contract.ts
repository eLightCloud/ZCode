import type { ZCodeApp, ZCodeAppOptions } from "./types.js";
/** Single native application constructor contract; existing create-app entry owns wiring. */
export type NativeAppFactory = (options: ZCodeAppOptions) => Promise<ZCodeApp>;
export type { ZCodeApp, ZCodeAppOptions, SendInputOptions, SendInputResult } from "./types.js";
export { decodePromptAttachmentDataUrl } from "./app-attachment-codec.js";
export { closeSessionResources } from "./session-resource-close.js";
