import * as implementation5 from "./protocol-server-client-requests.js";
import * as implementation3 from "./protocol-server-dispatch.js";
import * as implementation1 from "./protocol-server-lifecycle.js";
import * as implementation2 from "./protocol-server-messages.js";
import * as implementation4 from "./protocol-server-operation-signals.js";
import * as implementation0 from "./protocol-server-residency.js";
export function installZCodeProtocolAgentServerMethods(prototype: object): void {
  // 与 owner 共享原型和 this；保持方法不可枚举，clone/继承沿原路径工作。
  for (const methods of [
    implementation0,
    implementation1,
    implementation2,
    implementation3,
    implementation4,
    implementation5,
  ]) {
    for (const [name, value] of Object.entries(methods)) {
      Object.defineProperty(prototype, name, { value, writable: true, configurable: true });
    }
  }
}
