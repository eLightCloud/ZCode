/** Main-only application transport. Renderer receives neither workload token nor account cookie. */
import { app, session } from "electron";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { decodeZCodeBuiltinRelease } from "@zcode/provider-node";

let environment: Record<string, string> | undefined;

export function applicationModelBrokerEnvironment(logger?: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}): Record<string, string> {
  if (environment) return environment;
  const upstream = process.env["ZCODE_APPLICATION_MODEL_REMOTE_BASE_URL"];
  const configuration = process.env["ZCODE_APPLICATION_MODEL_REMOTE_CONFIG_URL"];
  if (!upstream && !configuration) return {};
  const origin = process.env["ZCODE_APPLICATION_PUBLIC_ORIGIN"];
  const csrfCookie = process.env["ZCODE_APPLICATION_CSRF_COOKIE"];
  const csrfHeader = process.env["ZCODE_APPLICATION_CSRF_HEADER"];
  const cookieNames = process.env["ZCODE_APPLICATION_SESSION_COOKIES"]?.split(",");
  const port = Number(process.env["ZCODE_APPLICATION_MODEL_BROKER_PORT"]);
  if (
    !upstream ||
    !configuration ||
    !origin ||
    !csrfCookie ||
    !csrfHeader ||
    !cookieNames?.length ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw new Error("application_model_broker_configuration_invalid");
  for (const value of [upstream, configuration, origin]) {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      throw new Error("application_model_broker_endpoint_invalid");
  }
  if (new URL(upstream).origin !== new URL(configuration).origin)
    throw new Error("application_model_broker_endpoint_invalid");
  const token = randomBytes(48).toString("base64url");
  const localBase = `http://127.0.0.1:${port}`;
  const directory = join(app.getPath("userData"), "application-models");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "providers.json");
  // 空基线确保登录/配置不可用时不会回落成另一个通道；首次成功获取沿同一个 Source 发布。
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      applicationDefault: {
        providerId: "application:unavailable",
        modelId: "__unavailable__",
        options: { reasoningLevel: "disabled" },
      },
      config: {
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    }),
    { mode: 0o600 },
  );
  let signature = "";
  let revision = Date.now();
  const server = createServer(async (request, response) => {
    const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (
      supplied.length !== token.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    ) {
      response.writeHead(401);
      response.end();
      return;
    }
    const path = request.url ?? "";
    const config = path === "/native/config" && request.method === "GET";
    const model =
      ["/v1/chat/completions", "/v1/messages", "/v1/responses"].includes(path) &&
      request.method === "POST";
    if (!config && !model) {
      response.writeHead(404);
      response.end();
      return;
    }
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    try {
      // 每次使用当前应用 Cookie，登录切换/登出立即改变授权；不接受 Renderer 指定主体。
      const cookies = await session.defaultSession.cookies.get({ url: origin });
      const selected = cookies.filter((cookie) => cookieNames.includes(cookie.name));
      const csrf = cookies.find((cookie) => cookie.name === csrfCookie)?.value;
      if (!selected.length || !csrf) {
        response.writeHead(401);
        response.end();
        return;
      }
      const headers: Record<string, string> = {
        Cookie: selected.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
        Origin: origin,
        [csrfHeader]: decodeURIComponent(csrf),
        "Content-Type": "application/json",
      };
      if (request.headers["anthropic-version"])
        headers["anthropic-version"] = String(request.headers["anthropic-version"]);
      let body: Buffer | undefined;
      if (model) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) {
            response.writeHead(413);
            response.end();
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        body = Buffer.concat(chunks);
      }
      const target = config ? configuration : upstream + path.slice(3);
      const result = await fetch(target, {
        method: request.method,
        headers,
        body,
        redirect: "error",
        signal: controller.signal,
      });
      logger?.info("application.model.transport", {
        outcome: result.ok ? "accepted" : "rejected",
        status: result.status,
      });
      if (config && result.ok) {
        const decoded = decodeZCodeBuiltinRelease(await result.json());
        const value = {
          schemaVersion: decoded.schemaVersion,
          revision: decoded.revision,
          ...(decoded.applicationDefault ? { applicationDefault: decoded.applicationDefault } : {}),
          config: {
            providerConfigRules: {
              templateRules: decoded.config.providerTemplates.toJSON(),
              providerRules: decoded.config.providers.toJSON().map((provider) => ({
                ...provider,
                config: {
                  ...provider.config,
                  api: { ...provider.config.api, baseUrl: localBase + "/v1" },
                },
              })),
            },
            modelConfigRules: decoded.config.modelConfigRules.toZCodeBuiltinJSON(),
          },
        };
        const current = JSON.stringify(value);
        if (signature !== current) {
          signature = current;
          revision += 1;
        }
        value.revision = revision;
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(value));
      } else {
        response.writeHead(result.status, {
          "content-type": result.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        });
        if (result.body)
          Readable.fromWeb(result.body as never)
            .on("error", () => response.destroy())
            .pipe(response);
        else response.end();
      }
    } catch (error) {
      logger?.warn("application.model.transport", {
        outcome: controller.signal.aborted ? "cancelled" : "failed",
        reason_code: error instanceof Error ? error.name : "transport_failure",
      });
      if (!response.headersSent) response.writeHead(503);
      response.end();
    }
  });
  server.on("error", () => {
    logger?.warn("application.model.broker", {
      outcome: "failed",
      reason_code: "listener_unavailable",
    });
    server.close();
  });
  server.listen(port, "127.0.0.1");
  app.once("before-quit", () => server.close());
  environment = {
    ZCODE_APPLICATION_PROVIDER_CONFIG_FILE: file,
    ZCODE_APPLICATION_MODEL_CONFIG_URL: localBase + "/native/config",
    ZCODE_APPLICATION_MODEL_BASE_URL: localBase + "/v1",
    ZCODE_APPLICATION_MODEL_TOKEN: token,
  };
  return environment;
}
