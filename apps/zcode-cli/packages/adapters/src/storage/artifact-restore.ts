import { open, mkdir, readdir, lstat, realpath, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { conversationArtifactUriSchema, ConversationRuntimeError } from "@zcode/shared";
import { contentTypeForFileName, extensionForBinaryContentType } from "./artifact-format.js";

function identity(root: string, session: string, uri: string) {
  const parsed = conversationArtifactUriSchema.safeParse(uri);
  if (!parsed.success || uri.split("/")[2] !== session)
    throw new ConversationRuntimeError("artifact_identity");
  return { directory: join(root, session), id: uri.split("/")[3]! };
}
async function safeDirectory(root: string, directory: string, create = false) {
  if (create) {
    await mkdir(root, { recursive: true });
    try {
      await mkdir(directory);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
        throw error;
    }
  }
  const metadata = await lstat(directory),
    actual = await realpath(directory),
    base = await realpath(root),
    inside = relative(base, actual);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    inside.startsWith("..") ||
    isAbsolute(inside)
  )
    throw new ConversationRuntimeError("artifact_path");
}
async function existing(directory: string, id: string) {
  const names = (await readdir(directory)).filter((name) => name.includes(id));
  if (names.length > 1) throw new ConversationRuntimeError("artifact_identity");
  return names[0] ? join(directory, names[0]) : null;
}
async function bytes(path: string) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new ConversationRuntimeError("artifact_path");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (before.ino !== current.ino || before.dev !== current.dev || current.size > 16 * 1024 * 1024)
      throw new ConversationRuntimeError("artifact_changed");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export async function readFixedArtifact(root: string, input: { sessionId: string; uri: string }) {
  const { directory, id } = identity(root, input.sessionId, input.uri);
  await safeDirectory(root, directory);
  const path = await existing(directory, id);
  if (!path) throw new ConversationRuntimeError("artifact_missing");
  return { uri: input.uri, bytes: await bytes(path), contentType: contentTypeForFileName(path) };
}
export async function restoreFixedArtifact(
  root: string,
  input: { sessionId: string; uri: string; bytes: Uint8Array; contentType: string },
) {
  if (input.bytes.byteLength > 16 * 1024 * 1024)
    throw new ConversationRuntimeError("artifact_size");
  const { directory, id } = identity(root, input.sessionId, input.uri);
  await safeDirectory(root, directory, true);
  let path = await existing(directory, id);
  if (!path) {
    const extension =
      (
        { "text/html": ".html", "text/csv": ".csv", "image/svg+xml": ".svg" } as Record<
          string,
          string
        >
      )[input.contentType] ?? extensionForBinaryContentType(input.contentType);
    path = join(directory, "restored-" + id + extension);
    const temporary = join(directory, ".restore-" + randomUUID());
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(input.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // 完整临时文件以 create-only 硬链接发布；崩溃不会留下同 URI 的半份正文。
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
        throw error;
    } finally {
      await unlink(temporary);
    }
  }
  const actual = await bytes(path);
  if (
    !actual.equals(Buffer.from(input.bytes)) ||
    contentTypeForFileName(path) !== input.contentType
  )
    throw new ConversationRuntimeError("artifact_collision");
}
