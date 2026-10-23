import { basename, resolvePath } from "../deps.js";

import type { FilePartSource, FileSystemPort, TurnAttachment } from "../deps.js";

import type { ResolvedTurnAttachment } from "../types.js";

import { resolvedPlaceholderAttachment } from "./attachment-placeholder.js";

import { inferImageMimeFromPath } from "./attachment-image.js";

import { inferVideoMimeFromPath } from "./attachment-video.js";

import {
  LocalMediaResolverOptions,
  localMediaReadFailure,
  resolveLocalImageAttachment,
  resolveLocalPdfAttachment,
  resolveLocalVideoAttachment,
} from "./local-media-resolver.js";

import type { LocalMediaContext } from "./local-media-resolver.js";

export { resolveInlineMediaAttachment } from "./inline-media-resolver.js";

export async function resolveLocalMediaAttachment(
  attachment: TurnAttachment,
  index: number,
  options: LocalMediaResolverOptions,
): Promise<ResolvedTurnAttachment> {
  const attachmentPath = attachment.path!;
  const absolutePath = resolvePath(options.workingDirectory, attachmentPath);
  const filename = basename(absolutePath);
  const mime =
    attachment.type === "image"
      ? inferImageMimeFromPath(absolutePath)
      : attachment.type === "pdf"
        ? "application/pdf"
        : (inferVideoMimeFromPath(absolutePath) ?? attachment.mimeType ?? "video/mp4");
  const source: FilePartSource = {
    type: "file",
    path: absolutePath,
    text: { value: attachmentPath, start: 0, end: attachmentPath.length },
  };
  let stat: Awaited<ReturnType<FileSystemPort["stat"]>>;
  try {
    stat = await options.fileSystemPort.stat(
      { path: absolutePath, trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch {
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  if (stat.kind !== "file") {
    return resolvedPlaceholderAttachment(attachment, attachmentPath, "attachment_not_file", {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
    });
  }

  const context: LocalMediaContext = {
    absolutePath,
    attachment,
    filename,
    index,
    mime,
    options,
    source,
    stat,
  };
  if (attachment.type === "image") return resolveLocalImageAttachment(context);
  if (attachment.type === "pdf") return resolveLocalPdfAttachment(context);
  return resolveLocalVideoAttachment(context);
}
