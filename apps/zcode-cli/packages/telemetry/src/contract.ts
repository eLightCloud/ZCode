/**
 * CLI 遥测 adapter 消费既有唯一 telemetry 端口；不另造 span、身份或执行 DTO。
 * 工厂 / 实现沿 index.ts，消费者只持有这些端口，不持有内部 writer 集合。
 */
export type {
  AgentExecutionTelemetryPort,
  AgentTelemetryRuntimeOwner,
  ModelExecutionTelemetryPort,
  TelemetryIdentitySnapshot,
} from "@zcode/contracts/telemetry";
