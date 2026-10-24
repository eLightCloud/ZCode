import type { ZCodeProtocolAgentDependencies } from "./contract.js";
import { ZCodeProtocolAgentServer } from "./server.js";

/** 复用宿主既有 app 工厂；协议不创建第二执行核心或恢复队列。 */
export function createNativeProtocolHost(dependencies: ZCodeProtocolAgentDependencies) {
  return new ZCodeProtocolAgentServer(dependencies);
}
