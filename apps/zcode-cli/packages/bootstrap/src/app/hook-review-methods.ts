import * as implementation3 from "./hook-review-persistence.js";
import * as implementation0 from "./hook-review-request.js";
import * as implementation1 from "./hook-review-response.js";
import * as implementation2 from "./hook-review-revocation.js";
export function installWorkspaceHookReviewControllerMethods(prototype: object): void {
  // 与 owner 共享原型和 this；保持方法不可枚举，clone/继承沿原路径工作。
  for (const methods of [implementation0, implementation1, implementation2, implementation3]) {
    for (const [name, value] of Object.entries(methods)) {
      Object.defineProperty(prototype, name, { value, writable: true, configurable: true });
    }
  }
}
