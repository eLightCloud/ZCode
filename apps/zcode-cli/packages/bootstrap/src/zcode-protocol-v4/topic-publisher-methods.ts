import * as implementation2 from "./topic-publisher-events.js";
import * as implementation4 from "./topic-publisher-flush.js";
import * as implementation5 from "./topic-publisher-resync.js";
import * as implementation1 from "./topic-publisher-row-queries.js";
import * as implementation0 from "./topic-publisher-snapshot.js";
import * as implementation3 from "./topic-publisher-subscribe.js";
export function installConversationTopicPublisherMethods(prototype: object): void {
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
