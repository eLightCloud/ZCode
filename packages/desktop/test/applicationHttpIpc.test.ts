import { EventEmitter } from "node:events";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { APPLICATION_HTTP_CHANNEL, APPLICATION_HTTP_CANCEL_CHANNEL } from "@zcode/shared";
const mocks = vi.hoisted(() => ({
  packaged: true,
  handlers: new Map<string, (...args: any[]) => any>(),
  fetch: vi.fn(),
  get: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.packaged;
    },
    getAppPath: () => "/owned/application",
  },
  BrowserWindow: { fromWebContents: () => ({ id: 1 }) },
  ipcMain: {
    handle: (channel: string, callback: (...args: any[]) => any) =>
      mocks.handlers.set(channel, callback),
  },
  session: { defaultSession: { fetch: mocks.fetch, cookies: { get: mocks.get } } },
}));
import { registerApplicationHttpIpc } from "../src/main/applicationHttp/index.js";
function event(id = 1) {
  const mainFrame = { url: "file:///owned/application/out/renderer/index.html?owned=1" };
  const sender = Object.assign(new EventEmitter(), {
    id,
    mainFrame,
    isDestroyed: () => false,
    getType: () => "window",
  });
  return { sender, senderFrame: mainFrame };
}
const input = {
  requestId: "c55266ab-2ab5-43af-94e4-39fac218cb0f",
  path: "/api/auth/me",
  method: "GET",
};
beforeEach(() => {
  mocks.packaged = true;
  vi.clearAllMocks();
  mocks.handlers.clear();
  vi.stubEnv("ZCODE_APPLICATION_ACCOUNT_API", "https://owned.invalid");
  vi.stubEnv("ZCODE_APPLICATION_PUBLIC_ORIGIN", "https://owned.invalid");
  vi.stubEnv("ZCODE_APPLICATION_API_PREFIXES", "");
  vi.stubEnv("ZCODE_APPLICATION_CSRF_COOKIE", "__Host-owned-csrf");
  vi.stubEnv("ZCODE_APPLICATION_CSRF_HEADER", "X-CSRF-Token");
  registerApplicationHttpIpc({ logger: mocks.logger });
});
afterEach(() => vi.unstubAllEnvs());
it("denies an iframe and a non-app file before private cookie/network access", async () => {
  const invoke = mocks.handlers.get(APPLICATION_HTTP_CHANNEL)!;
  const iframe = event();
  iframe.senderFrame = { ...iframe.senderFrame };
  expect((await invoke(iframe, input)).status).toBe(403);
  const outside = event();
  outside.senderFrame.url = "file:///tmp/untrusted.html";
  expect((await invoke(outside, input)).status).toBe(403);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("denies a webview even if its file URL matches the application", async () => {
  const guest = event();
  guest.sender.getType = () => "webview";
  expect((await mocks.handlers.get(APPLICATION_HTTP_CHANNEL)!(guest, input)).status).toBe(403);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("never trusts an external development renderer origin", async () => {
  mocks.packaged = false;
  vi.stubEnv("ELECTRON_RENDERER_URL", "https://other.invalid");
  const outside = event();
  outside.senderFrame.url = "https://other.invalid/";
  expect((await mocks.handlers.get(APPLICATION_HTTP_CHANNEL)!(outside, input)).status).toBe(403);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("denies a destination or Cookie override without making a request", async () => {
  const invoke = mocks.handlers.get(APPLICATION_HTTP_CHANNEL)!;
  expect((await invoke(event(), { ...input, headers: { Cookie: "synthetic" } })).status).toBe(400);
  expect(
    (await invoke(event(), { ...input, path: "https://other.invalid/api/auth/me" })).status,
  ).toBe(400);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("scopes cancellation to the sender, then releases listeners and the in-flight ID", async () => {
  mocks.fetch.mockImplementationOnce(
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("owned_abort"))),
      ),
  );
  const owner = event(),
    invoke = mocks.handlers.get(APPLICATION_HTTP_CHANNEL)!;
  const pending = invoke(owner, input);
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  const cancel = mocks.handlers.get(APPLICATION_HTTP_CANCEL_CHANNEL)!;
  cancel(event(2), input.requestId);
  expect(mocks.fetch.mock.calls[0]![1].signal.aborted).toBe(false);
  cancel(owner, input.requestId);
  expect((await pending).status).toBe(499);
  expect(owner.sender.eventNames()).toEqual([]);
  mocks.fetch.mockResolvedValueOnce(new Response("{}"));
  expect((await invoke(owner, input)).status).toBe(200);
});
it("cancels the original request on top-level navigation", async () => {
  mocks.fetch.mockImplementationOnce(
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("owned_abort"))),
      ),
  );
  const owner = event(),
    pending = mocks.handlers.get(APPLICATION_HTTP_CHANNEL)!(owner, input);
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  owner.sender.emit("did-start-navigation", {}, "https://other.invalid", false, true);
  expect((await pending).status).toBe(499);
  expect(owner.sender.eventNames()).toEqual([]);
});
