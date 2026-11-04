import type { Cookies, CookiesSetDetails } from "electron";
import { getSetCookies, Headers as CookieHeaders } from "undici";

/** Private transport adapter; the caller has already admitted the fixed target. */
export function createApplicationSessionFetch(
  cookies: Pick<Cookies, "get" | "set">,
  allowedNames: readonly string[] | undefined,
  fetch: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    globalThis.fetch(url, init),
): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const headers = new Headers(init.headers);
    if (init.credentials === "include" && !headers.has("Cookie")) {
      const current = await cookies.get({ url });
      headers.set(
        "Cookie",
        current.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
      );
    }
    // Electron session.fetch 拒绝显式 Origin；Node fetch 可发送，但不会维护 Main Cookie jar。
    // 因此保持现有出站白名单，并在返回登录/退出结果前把服务端 Cookie 写回同一 owner。
    const response = await fetch(url, { ...init, headers });
    const cookieHeaders = new CookieHeaders();
    for (const value of response.headers.getSetCookie())
      cookieHeaders.append("set-cookie", value);
    const pathname = new URL(url).pathname;
    const defaultPath = pathname.slice(0, pathname.lastIndexOf("/")) || "/";
    for (const cookie of getSetCookies(cookieHeaders)) {
      if (allowedNames && !allowedNames.includes(cookie.name)) continue;
      const details: CookiesSetDetails = {
        url,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path?.startsWith("/") ? cookie.path : defaultPath,
        secure: cookie.secure ?? false,
        httpOnly: cookie.httpOnly ?? false,
        sameSite:
          cookie.sameSite === "None"
            ? "no_restriction"
            : cookie.sameSite === "Strict"
              ? "strict"
              : cookie.sameSite === "Lax"
                ? "lax"
                : "unspecified",
      };
      if (cookie.domain) details.domain = cookie.domain;
      if (cookie.maxAge !== undefined)
        details.expirationDate =
          cookie.maxAge <= 0 ? 1 : Date.now() / 1000 + cookie.maxAge;
      else if (cookie.expires !== undefined)
        details.expirationDate = Math.max(
          1,
          new Date(cookie.expires).getTime() / 1000,
        );
      // Electron 的手动 Cookie API 不允许非 HttpOnly 写入覆盖 HttpOnly 会话。
      // 服务端退出响应可省略此属性；过期写入需以 HttpOnly 能力删除同路径会话。
      if (
        details.expirationDate !== undefined &&
        details.expirationDate <= Date.now() / 1000
      )
        details.httpOnly = true;
      try {
        await cookies.set(details);
      } catch {
        // 错误只暴露稳定原因码，不能把 Cookie 值或 Electron 原始异常写入日志。
        await response.body?.cancel();
        throw new Error("application_http_cookie_persistence_failed");
      }
    }
    return response;
  };
}
