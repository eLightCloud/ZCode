import { describe, expect, it, vi } from "vitest";
import { createApplicationSessionFetch } from "../src/main/applicationHttp/sessionFetch.js";

describe("Main application session transport", () => {
  it("preserves the explicit Origin and cookie allowlist, then persists rotated cookies before returning", async () => {
    const cookies = { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined) };
    const response = new Response("{}", {
      headers: [
        [
          "set-cookie",
          "__Host-session=synthetic; Secure; HttpOnly; Path=/; SameSite=Lax",
        ],
        ["set-cookie", "__Host-csrf=proof; Secure; Path=/; SameSite=Strict"],
        ["set-cookie", "unrelated=excluded; Path=/"],
      ],
    });
    const fetch = vi.fn().mockResolvedValue(response);
    const request = createApplicationSessionFetch(
      cookies,
      ["__Host-session", "__Host-csrf"],
      fetch,
    );
    const signal = new AbortController().signal;
    expect(
      await request("https://owned.invalid/api/auth/login", {
        headers: { Origin: "https://owned.invalid:8443", Cookie: "" },
        credentials: "omit",
        redirect: "error",
        signal,
      }),
    ).toBe(response);
    expect(cookies.get).not.toHaveBeenCalled();
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("Origin")).toBe(
      "https://owned.invalid:8443",
    );
    expect(new Headers(init.headers).get("Cookie")).toBe("");
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      signal,
    });
    expect(cookies.set.mock.calls.map(([cookie]) => cookie)).toEqual([
      {
        url: "https://owned.invalid/api/auth/login",
        name: "__Host-session",
        value: "synthetic",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      },
      {
        url: "https://owned.invalid/api/auth/login",
        name: "__Host-csrf",
        value: "proof",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "strict",
      },
    ]);
  });

  it("reads the current API cookie jar when the application has no name allowlist", async () => {
    const cookies = {
      get: vi.fn().mockResolvedValue([{ name: "session", value: "synthetic" }]),
      set: vi.fn(),
    };
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    const request = createApplicationSessionFetch(cookies, undefined, fetch);
    await request("https://owned.invalid/api/auth/me", {
      credentials: "include",
    });
    expect(cookies.get).toHaveBeenCalledWith({
      url: "https://owned.invalid/api/auth/me",
    });
    expect(new Headers(fetch.mock.calls[0]![1].headers).get("cookie")).toBe(
      "session=synthetic",
    );
  });

  it("applies logout expiry, Max-Age precedence and the response URL's default path", async () => {
    const cookies = { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined) };
    const fetch = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: [
          [
            "set-cookie",
            "session=; Max-Age=0; Expires=Wed, 01 Jan 2042 00:00:00 GMT; Path=/",
          ],
          [
            "set-cookie",
            "csrf=rotated; Max-Age=600; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
          ],
          [
            "set-cookie",
            "expired=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=owned.invalid",
          ],
        ],
      }),
    );
    const before = Date.now() / 1000;
    await createApplicationSessionFetch(
      cookies,
      undefined,
      fetch,
    )("https://owned.invalid/api/auth/logout", {});
    expect(cookies.set.mock.calls[0]![0]).toMatchObject({
      name: "session",
      expirationDate: 1,
      path: "/",
      httpOnly: true,
    });
    expect(cookies.set.mock.calls[1]![0]).toMatchObject({
      name: "csrf",
      path: "/api/auth",
    });
    expect(cookies.set.mock.calls[1]![0].expirationDate).toBeGreaterThanOrEqual(
      before + 600,
    );
    expect(cookies.set.mock.calls[2]![0]).toMatchObject({
      name: "expired",
      expirationDate: 1,
      domain: "owned.invalid",
    });
  });

  it("does not report successful login when cookie persistence fails", async () => {
    const cookies = {
      get: vi.fn(),
      set: vi.fn().mockRejectedValue(new Error("private cookie detail")),
    };
    const fetch = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: { "set-cookie": "session=synthetic; Path=/" },
      }),
    );
    await expect(
      createApplicationSessionFetch(
        cookies,
        ["session"],
        fetch,
      )("https://owned.invalid/api/auth/login", {}),
    ).rejects.toThrow("application_http_cookie_persistence_failed");
  });
});
