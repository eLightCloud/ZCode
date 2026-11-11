import { runTui, type TuiOptions } from "./contract.js";

/** 名称由进程入口校验；终端只负责展示，异步启动仍由调用方回调拥有。 */
export async function showTerminal(options: TuiOptions, applicationName: string): Promise<number> {
  return runTui({ ...options, applicationName });
}
