import * as implementation1 from "./projection-action-targets.js";
import * as implementation15 from "./projection-background-events.js";
import * as implementation17 from "./projection-compact-events.js";
import * as implementation0 from "./projection-configuration.js";
import * as implementation19 from "./projection-control-state.js";
import * as implementation2 from "./projection-event-commit.js";
import * as implementation3 from "./projection-event-dispatch.js";
import * as implementation18 from "./projection-goal-events.js";
import * as implementation4 from "./projection-hook-events.js";
import * as implementation16 from "./projection-model-completion.js";
import * as implementation7 from "./projection-model-stream.js";
import * as implementation8 from "./projection-network-status.js";
import * as implementation11 from "./projection-permission-events.js";
import * as implementation12 from "./projection-queue-events.js";
import * as implementation13 from "./projection-queue-state.js";
import * as implementation21 from "./projection-row-index.js";
import * as implementation14 from "./projection-subagent-events.js";
import * as implementation10 from "./projection-tool-results.js";
import * as implementation9 from "./projection-tool-stream.js";
import * as implementation6 from "./projection-turn-end.js";
import * as implementation5 from "./projection-turn-start.js";
import * as implementation20 from "./projection-turn-timing.js";
export function installProductProjectionMethods(prototype: object): void {
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
    implementation21,
  ]) {
    for (const [name, value] of Object.entries(methods)) {
      Object.defineProperty(prototype, name, { value, writable: true, configurable: true });
    }
  }
}
