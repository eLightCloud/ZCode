import type { ZCodeProtocolRequest } from "@zcode/shared";
import {
  V4_NOTIFICATIONS,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeProtocolAgentServerMethodsContext } from "./protocol-server-context.js";
// topic 家族路由与 ACK 后帧提交属于同一个订阅操作。
export async function subscribeConversationTopic(
  this: ZCodeProtocolAgentServerMethodsContext,
  request: ZCodeProtocolRequest,
) {
  // 同一 subscribe 方法按 topic 前缀分派：
  // sessions-index/* → 列表订阅；workspace-config/* → 配置目录订阅；否则 conversation。
  const gateway = this.requireV4Gateway();
  const topic = (request.params as { topic?: unknown } | null)?.topic;
  let dispatch;
  if (typeof topic === "string" && parseSessionsIndexTopic(topic) !== null) {
    dispatch = await gateway.subscribeSessionsIndexReserved(request.params);
  } else if (typeof topic === "string" && parseWorkspaceConfigTopic(topic) !== null) {
    dispatch = await gateway.subscribeWorkspaceConfigReserved(request.params);
  } else {
    dispatch = await gateway.subscribeReserved(request.params);
  }
  if (dispatch.initialWires.length > 0) {
    this.postResponseOutbox.set(request.id, {
      messages: dispatch.initialWires.map((wire) => ({
        method: V4_NOTIFICATIONS.conversationFrame,
        params: wire,
      })),
      commit: dispatch.commit,
    });
  }
  return { ack: dispatch.ack };
}
