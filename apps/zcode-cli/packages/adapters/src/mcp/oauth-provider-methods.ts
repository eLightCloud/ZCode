import * as implementation0 from "./oauth-provider-client.js";
import * as implementation2 from "./oauth-provider-credentials.js";
import * as implementation1 from "./oauth-provider-verifier.js";
export function installZCodeMcpAuthorizationCodeProviderMethods(prototype: object): void {
  // 与 owner 共享原型和 this；保持方法不可枚举，clone/继承沿原路径工作。
  for (const methods of [implementation0, implementation1, implementation2]) {
    for (const [name, value] of Object.entries(methods)) {
      Object.defineProperty(prototype, name, { value, writable: true, configurable: true });
    }
  }
}
