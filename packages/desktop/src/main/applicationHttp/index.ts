import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPLICATION_HTTP_CHANNEL,
  APPLICATION_HTTP_CANCEL_CHANNEL,
  applicationHttpRequestSchema,
} from "@zcode/shared";
import type { ApplicationHttpRegistrationOptions } from "./contract.js";
import { readApplicationHttpConfiguration } from "./configuration.js";
import { applicationHttpFailure, performApplicationHttp } from "./transport.js";

function trustedSender(event: IpcMainInvokeEvent): boolean {
  if (
    event.sender.isDestroyed() ||
    event.sender.getType() !== "window" ||
    event.senderFrame !== event.sender.mainFrame ||
    !BrowserWindow.fromWebContents(event.sender)
  )
    return false;
  try {
    const value = new URL(event.senderFrame.url);
    if (app.isPackaged)
      return (
        value.protocol === "file:" &&
        fileURLToPath(value) === join(app.getAppPath(), "out/renderer/index.html")
      );
    const development = process.env.ELECTRON_RENDERER_URL;
    if (!development) return false;
    const target = new URL(development);
    if (
      !["http:", "https:"].includes(target.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
    )
      return false;
    return (
      value.origin === target.origin &&
      [target.pathname, target.pathname.replace(/\/$/, "") + "/index.html"].includes(value.pathname)
    );
  } catch {
    return false;
  }
}

export function registerApplicationHttpIpc({ logger }: ApplicationHttpRegistrationOptions): void {
  let configuration: ReturnType<typeof readApplicationHttpConfiguration> = undefined;
  let configurationInvalid = false;
  try {
    configuration = readApplicationHttpConfiguration(process.env, app.isPackaged);
  } catch {
    configurationInvalid = true;
  }
  logger.info("application.http.configuration", {
    outcome: configuration ? "configured" : "unavailable",
    reasonCode: configurationInvalid
      ? "configuration_invalid"
      : configuration
        ? "ready"
        : "not_configured",
  });
  const active = new Map<number, Map<string, AbortController>>();
  ipcMain.handle(APPLICATION_HTTP_CANCEL_CHANNEL, (event, requestId: unknown) => {
    if (!trustedSender(event) || typeof requestId !== "string") return;
    active.get(event.sender.id)?.get(requestId)?.abort();
  });
  ipcMain.handle(APPLICATION_HTTP_CHANNEL, async (event, raw: unknown) => {
    const correlationId = randomUUID();
    const reject = (status: number, reasonCode: string) => {
      logger.warn("application.http.request", {
        correlationId,
        status,
        outcome: "rejected",
        reasonCode,
      });
      return applicationHttpFailure(status, reasonCode);
    };
    if (!trustedSender(event)) {
      logger.warn("application.http.request", {
        correlationId,
        outcome: "rejected",
        reasonCode: "untrusted_renderer",
      });
      return applicationHttpFailure(403, "application_http_sender_rejected");
    }
    const decoded = applicationHttpRequestSchema.safeParse(raw);
    if (!decoded.success) return reject(400, "application_http_request_invalid");
    if (!configuration) return reject(503, "application_http_not_configured");
    const input = decoded.data;
    const senderId = event.sender.id;
    const requests = active.get(senderId) ?? new Map<string, AbortController>();
    if (requests.has(input.requestId) || requests.size >= 32)
      return reject(429, "application_http_in_flight_limit");
    const controller = new AbortController();
    requests.set(input.requestId, controller);
    active.set(senderId, requests);
    const abort = () => controller.abort();
    const navigation = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => {
      if (main) abort();
    };
    event.sender.once("destroyed", abort);
    event.sender.once("render-process-gone", abort);
    event.sender.on("did-start-navigation", navigation);
    const timeout = AbortSignal.timeout(30_000);
    try {
      const result = await performApplicationHttp(
        configuration,
        input,
        {
          cookies: session.defaultSession.cookies,
          fetch: (url, init) => session.defaultSession.fetch(url, init),
        },
        AbortSignal.any([controller.signal, timeout]),
      );
      logger.info("application.http.request", {
        correlationId,
        senderId,
        outcome: result.status < 400 ? "accepted" : "rejected",
        status: result.status,
      });
      return result;
    } catch (error) {
      const rejected = error instanceof Error && error.message === "application_http_path_rejected";
      const status = rejected ? 400 : controller.signal.aborted ? 499 : timeout.aborted ? 504 : 503;
      logger.warn("application.http.request", {
        correlationId,
        senderId,
        status,
        outcome: rejected ? "rejected" : controller.signal.aborted ? "cancelled" : "failed",
        reasonCode: rejected
          ? "path_rejected"
          : controller.signal.aborted
            ? "cancelled"
            : timeout.aborted
              ? "deadline"
              : "transport_unavailable",
      });
      return applicationHttpFailure(status, "application_http_unavailable");
    } finally {
      event.sender.removeListener("destroyed", abort);
      event.sender.removeListener("render-process-gone", abort);
      event.sender.removeListener("did-start-navigation", navigation);
      requests.delete(input.requestId);
      if (!requests.size) active.delete(senderId);
    }
  });
}
