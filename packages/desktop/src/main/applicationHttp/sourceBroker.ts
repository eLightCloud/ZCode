import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { ApplicationHttpLogger } from "./contract.js";
import {
  applicationHttpTarget,
  type ApplicationHttpConfiguration,
} from "./configuration.js";
import { performApplicationHttp } from "./transport.js";

/** Only a transient transport capability crosses into the native downloader. */
export async function createPluginHttpBroker(options: {
  configuration: ApplicationHttpConfiguration;
  sources: Array<{ origin: string; pathPrefix: string }>;
  directory: string;
  logger: ApplicationHttpLogger;
  transport: Parameters<typeof performApplicationHttp>[2];
}) {
  const token = randomBytes(32).toString("hex");
  const secret = Buffer.from("Bearer " + token);
  const directory = await mkdtemp(join(options.directory, "plugin-http-"));
  const controllers = new Set<AbortController>();
  const server = createServer(async (request, response) => {
    const correlationId = randomUUID();
    let status = 503;
    let phase = "admission";
    let reasonCode: string | undefined;
    const controller = new AbortController();
    const abort = () => {
      if (!response.writableEnded) controller.abort();
    };
    try {
      const auth = Buffer.from(request.headers.authorization ?? "");
      if (auth.length !== secret.length || !timingSafeEqual(auth, secret)) {
        status = 401;
        response.writeHead(status).end();
        return;
      }
      const path = request.url ?? "";
      // Node 会保留原始路径；先拒绝规范化越界，再验证启动配置的下载子树。
      const target = applicationHttpTarget(options.configuration, path);
      if (
        request.method !== "GET" ||
        !options.sources.some((source) =>
          target.pathname.startsWith(source.pathPrefix),
        )
      ) {
        status = 403;
        response.writeHead(status).end();
        return;
      }
      if (controllers.size >= 32) {
        status = 429;
        response.writeHead(status).end();
        return;
      }
      controllers.add(controller);
      response.once("close", abort);
      phase = "transport";
      const result = await performApplicationHttp(
        options.configuration,
        { requestId: correlationId, path, method: "GET" },
        options.transport,
        AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      );
      status = result.status;
      phase = "response";
      response.writeHead(status, Object.fromEntries(result.headers));
      response.end(Buffer.from(result.body));
    } catch (error) {
      reasonCode = `${phase}_${error instanceof TypeError ? "type_error" : "failed"}`;
      status =
        error instanceof Error &&
        error.message === "application_http_path_rejected"
          ? 403
          : 503;
      if (!response.headersSent) response.writeHead(status);
      response.end();
    } finally {
      controllers.delete(controller);
      response.removeListener("close", abort);
      options.logger.info("application.http.plugin_source", {
        correlationId,
        status,
        outcome: status < 400 ? "accepted" : "rejected",
        ...(reasonCode ? { reasonCode } : {}),
      });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("application_plugin_http_unavailable");
    const transportOrigin = `http://127.0.0.1:${address.port}`;
    const credentialFile = join(directory, "credentials.json");
    await writeFile(
      credentialFile,
      JSON.stringify({
        version: 1,
        bindings: options.sources.map((source) => ({
          ...source,
          token,
          transportOrigin,
          allowInsecureTransport: true,
        })),
      }),
      { mode: 0o600, flag: "wx" },
    );
    return {
      credentialFile,
      async dispose() {
        for (const controller of controllers) controller.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
