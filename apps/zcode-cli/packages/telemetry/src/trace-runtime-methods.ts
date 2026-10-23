import * as implementation2 from "./trace-runtime-model.js";
import * as implementation1 from "./trace-runtime-operations.js";
import * as implementation0 from "./trace-runtime-session.js";
import * as implementation3 from "./trace-runtime-writer-lifecycle.js";
export function installAgentExecutionTelemetryRuntimeMethods(prototype: object): void {
  // 与 owner 共享原型和 this；保持方法不可枚举，clone/继承沿原路径工作。
  for (const methods of [implementation0, implementation1, implementation2, implementation3]) {
    for (const [name, value] of Object.entries(methods)) {
      Object.defineProperty(prototype, name, { value, writable: true, configurable: true });
    }
  }
}
