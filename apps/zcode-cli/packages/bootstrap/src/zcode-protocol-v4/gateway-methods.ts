import * as implementation14 from "./gateway-attachment-binary.js";
import * as implementation12 from "./gateway-attachment-conversation.js";
import * as implementation13 from "./gateway-attachment-media.js";
import * as implementation11 from "./gateway-attachment-uploads.js";
import * as implementation15 from "./gateway-command-dispatch.js";
import * as implementation16 from "./gateway-command-queries.js";
import * as implementation0 from "./gateway-connection-flow.js";
import * as implementation7 from "./gateway-conversation-resync.js";
import * as implementation6 from "./gateway-conversation-subscribe.js";
import * as implementation3 from "./gateway-detached-events.js";
import * as implementation2 from "./gateway-event-commit.js";
import * as implementation20 from "./gateway-event-sequence.js";
import * as implementation19 from "./gateway-hydration.js";
import * as implementation1 from "./gateway-live-events.js";
import * as implementation18 from "./gateway-publisher.js";
import * as implementation10 from "./gateway-row-queries.js";
import * as implementation17 from "./gateway-session-cleanup.js";
import * as implementation4 from "./gateway-session-index.js";
import * as implementation9 from "./gateway-workflow-artifacts.js";
import * as implementation8 from "./gateway-workflow-queries.js";
import * as implementation5 from "./gateway-workspace-config.js";
export function installConversationV4GatewayMethods(prototype: object): void {
  // 与 owner 共享原型和 this；保持方法不可枚举，clone/继承沿原路径工作。
  for (const methods of [
    implementation0,
    implementation1,
    implementation2,
    implementation3,
    implementation4,
    implementation5,
    implementation6,
    implementation7,
    implementation8,
    implementation9,
    implementation10,
    implementation11,
    implementation12,
    implementation13,
    implementation14,
    implementation15,
    implementation16,
    implementation17,
    implementation18,
    implementation19,
    implementation20,
  ]) {
    for (const [name, value] of Object.entries(methods)) {
      Object.defineProperty(prototype, name, { value, writable: true, configurable: true });
    }
  }
}
