import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DeliverableStorePort, PublishDeliverableInput, Logger } from "@zcode/contracts";
import {
  nativeDeliverableSchema,
  nativeDeliverablesListInputSchema,
  nativeDeliverableReadSchema,
  nativeDeliverableReleaseSchema,
  type NativeDeliverable,
} from "@zcode/shared";

const COPY_CHUNK_BYTES = 256 * 1024;
const FIRST_PRINTABLE_CODE = 0x20;
const ASCII_DELETE_CODE = 0x7f;

type Row = { descriptor: string; snapshot: string; fingerprint: string; sequence: number };

/** 异步文件 IO；SQLite 仅执行短元数据事务，不在事务中复制或哈希。 */
export class NodeDeliverableStore implements DeliverableStorePort {
  private db?: InstanceType<typeof DatabaseSync>;
  private opening?: Promise<void>;

  constructor(
    private readonly root: string,
    private readonly logger?: Logger,
  ) {}

  private async database() {
    if (!this.opening) this.opening = this.initialize();
    await this.opening;
    if (!this.db) throw new Error("deliverable_store_closed");
    return this.db;
  }

  private async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, "deliverables.sqlite");
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS deliveries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_key TEXT NOT NULL, request_key TEXT NOT NULL,
      id TEXT NOT NULL, version INTEGER NOT NULL,
      descriptor TEXT NOT NULL, snapshot TEXT NOT NULL, fingerprint TEXT NOT NULL,
      UNIQUE(workspace_key, request_key), UNIQUE(id, version)
    ); CREATE INDEX IF NOT EXISTS deliveries_workspace_sequence
      ON deliveries(workspace_key, sequence);`);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS snapshot_releases (id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(id,version))",
    );
    await chmod(path, 0o600);
  }

  async publish(input: PublishDeliverableInput, options: { signal?: AbortSignal } = {}) {
    try {
      const file = await this.publishSnapshot(input, options);
      this.logger?.info("Native delivery snapshot available", {
        event: "delivery.snapshot",
        status: "completed",
        traceId: input.trace.traceId,
        sessionId: input.sessionId,
        deliverableId: file.id,
        version: file.version,
        sizeBytes: file.size,
      });
      return file;
    } catch (error) {
      const reason =
        error instanceof Error && /^deliverable_[a-z_]{1,64}$/.test(error.message)
          ? error.message
          : "deliverable_snapshot_failed";
      this.logger?.warn("Native delivery snapshot failed", {
        event: "delivery.snapshot",
        status: "failed",
        traceId: input.trace.traceId,
        sessionId: input.sessionId,
        reasonCode: reason,
      });
      throw error;
    }
  }

  private async publishSnapshot(input: PublishDeliverableInput, options: { signal?: AbortSignal }) {
    const db = await this.database();
    const requestKey = createHash("sha256")
      .update(
        JSON.stringify([
          input.workspaceKey,
          input.sessionId,
          input.turnId ?? input.producerContextRef ?? null,
          input.requestKey,
        ]),
      )
      .digest("hex");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          sourcePath: resolve(input.workspacePath, input.sourcePath),
          sessionId: input.sessionId,
          turnId: input.turnId,
          previous: input.previous,
          producerContextRef: input.producerContextRef,
        }),
      )
      .digest("hex");
    const findOriginal = () =>
      db
        .prepare("SELECT * FROM deliveries WHERE workspace_key=? AND request_key=?")
        .get(input.workspaceKey, requestKey) as Row | undefined;
    const original = findOriginal();
    if (original) return this.original(original, fingerprint);
    options.signal?.throwIfAborted();
    const workspace = await realpath(input.workspacePath);
    const source = await realpath(resolve(workspace, input.sourcePath));
    const within = relative(workspace, source);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new Error("deliverable_source_outside_workspace");
    }
    const snapshot = randomUUID();
    const destination = join(this.root, snapshot);
    let registered = false;
    try {
      const { size, sha256 } = await this.snapshot(source, destination, options.signal);
      options.signal?.throwIfAborted();
      const name = basename(source);
      if (
        Array.from(name).some((character) => {
          const code = character.charCodeAt(0);
          return code < FIRST_PRINTABLE_CODE || code === ASCII_DELETE_CODE;
        })
      )
        throw new Error("deliverable_name_invalid");
      // 文件 IO 完成后才进入元数据事务。重复进程只能绑定自己的随机候选，不能删赢家。
      db.exec("BEGIN IMMEDIATE");
      try {
        const replay = findOriginal();
        if (replay) {
          const result = this.original(replay, fingerprint);
          db.exec("COMMIT");
          return result;
        }
        let id: string = randomUUID();
        let version = 1;
        if (input.previous) {
          const latest = db
            .prepare(
              "SELECT MAX(version) AS version FROM deliveries WHERE workspace_key=? AND id=?",
            )
            .get(input.workspaceKey, input.previous.id) as { version: number | null };
          if (latest.version !== input.previous.version)
            throw new Error("deliverable_revision_conflict");
          id = input.previous.id;
          version = input.previous.version + 1;
        }
        const descriptor = nativeDeliverableSchema.parse({
          kind: "file",
          purpose: "final",
          id,
          version,
          sequence: 1,
          workspaceKey: input.workspaceKey,
          sessionId: input.sessionId,
          turnId: input.turnId,
          requestKey,
          producerContextRef: input.producerContextRef,
          previous: input.previous,
          name,
          size,
          sha256,
          createdAt: new Date().toISOString(),
        });
        const inserted = db
          .prepare(`INSERT INTO deliveries
          (workspace_key,request_key,id,version,descriptor,snapshot,fingerprint)
          VALUES(?,?,?,?,?,?,?)`)
          .run(
            input.workspaceKey,
            requestKey,
            id,
            version,
            JSON.stringify(descriptor),
            snapshot,
            fingerprint,
          );
        descriptor.sequence = Number(inserted.lastInsertRowid);
        db.prepare("UPDATE deliveries SET descriptor=? WHERE sequence=?").run(
          JSON.stringify(descriptor),
          descriptor.sequence,
        );
        db.exec("COMMIT");
        registered = true;
        return descriptor;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      if (!registered)
        await unlink(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
  }

  private original(row: Row, fingerprint: string): NativeDeliverable {
    if (row.fingerprint !== fingerprint) throw new Error("deliverable_request_conflict");
    return nativeDeliverableSchema.parse(JSON.parse(row.descriptor));
  }

  private async snapshot(source: string, destination: string, signal?: AbortSignal) {
    const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await input.stat();
      const current = await stat(source);
      if (
        (await realpath(source)) !== source ||
        current.dev !== before.dev ||
        current.ino !== before.ino
      )
        throw new Error("deliverable_source_changed");
      if (!before.isFile()) throw new Error("deliverable_source_not_regular");
      output = await open(destination, "wx", 0o600);
      const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
      const hash = createHash("sha256");
      let size = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await input.read(buffer, 0, buffer.length, size);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > before.size) throw new Error("deliverable_source_changed");
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(chunk, written, bytesRead - written);
          written += result.bytesWritten;
        }
      }
      const after = await input.stat();
      const stillNamed = await stat(source);
      if (stillNamed.dev !== before.dev || stillNamed.ino !== before.ino)
        throw new Error("deliverable_source_changed");
      if (
        size !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error("deliverable_source_changed");
      await output.sync();
      if (process.platform !== "win32") {
        const directory = await open(this.root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      return { size, sha256: hash.digest("hex") };
    } finally {
      await output?.close();
      await input.close();
    }
  }

  async list(raw: { workspaceKey: string; after: number; limit: number }) {
    const input = nativeDeliverablesListInputSchema.parse(raw);
    const db = await this.database();
    const rows = db
      .prepare(`SELECT descriptor FROM deliveries
      WHERE workspace_key=? AND sequence>? ORDER BY sequence LIMIT ?`)
      .all(input.workspaceKey, input.after, input.limit) as { descriptor: string }[];
    const entries = rows.map((row) => nativeDeliverableSchema.parse(JSON.parse(row.descriptor)));
    return { entries, cursor: entries.at(-1)?.sequence ?? input.after };
  }

  async read(raw: {
    workspaceKey: string;
    id: string;
    version: number;
    offset: number;
    length: number;
  }) {
    const input = nativeDeliverableReadSchema.parse(raw);
    const db = await this.database();
    const row = db
      .prepare("SELECT * FROM deliveries WHERE workspace_key=? AND id=? AND version=?")
      .get(input.workspaceKey, input.id, input.version) as Row | undefined;
    if (!row) throw new Error("deliverable_not_found");
    const descriptor = nativeDeliverableSchema.parse(JSON.parse(row.descriptor));
    if (input.offset > descriptor.size) throw new Error("deliverable_range_invalid");
    if (
      db
        .prepare("SELECT 1 FROM snapshot_releases WHERE id=? AND version=?")
        .get(input.id, input.version)
    )
      throw new Error("deliverable_snapshot_released");
    const file = await open(join(this.root, row.snapshot), "r");
    try {
      const buffer = Buffer.alloc(Math.min(input.length, descriptor.size - input.offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, input.offset);
      if (bytesRead !== buffer.length) throw new Error("deliverable_snapshot_damaged");
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await file.close();
    }
  }

  async release(raw: { workspaceKey: string; id: string; version: number; sha256: string }) {
    const input = nativeDeliverableReleaseSchema.parse(raw);
    const db = await this.database();
    const row = db
      .prepare("SELECT * FROM deliveries WHERE workspace_key=? AND id=? AND version=?")
      .get(input.workspaceKey, input.id, input.version) as Row | undefined;
    if (!row) throw new Error("deliverable_not_found");
    const descriptor = nativeDeliverableSchema.parse(JSON.parse(row.descriptor));
    if (descriptor.sha256 !== input.sha256) throw new Error("deliverable_request_conflict");
    db.prepare("INSERT OR IGNORE INTO snapshot_releases VALUES (?,?)").run(input.id, input.version);
    // 保留声明用于历史重放，只释放准确快照；重复确认不复活字节。
    await unlink(join(this.root, row.snapshot)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.logger?.info("Native delivery snapshot released", {
      event: "delivery.snapshot",
      status: "completed",
      operation: "release",
      deliverableId: input.id,
      version: input.version,
    });
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }
}
