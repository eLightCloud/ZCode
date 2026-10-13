// Vite 与 Electron 就绪探针必须使用同一端口，否则自定义端口后会永久等待。
export function resolveDesktopDevPort(env = process.env) {
  const value = env.ZCODE_DESKTOP_DEV_PORT ?? "5174";
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("desktop.development.invalid-port");
  }
  return port;
}
