import { z } from "zod";

export const runtimeMaintenanceParamsSchema = z.object({
  action: z.enum(["begin", "status", "cancel"]),
  operationId: z.string().uuid(),
}).strict();
export type RuntimeMaintenanceParams = z.infer<typeof runtimeMaintenanceParamsSchema>;

export const runtimeMaintenanceResultSchema = z.object({
  operationId: z.string().uuid().nullable(),
  state: z.enum(["held", "blocked", "released"]),
  reasonCode: z.enum(["native_activity", "operation_conflict", "unconfirmed"]).optional(),
}).strict().refine(value => (value.state !== "held" || value.operationId !== null)
  && (value.state !== "released" || value.operationId === null), "Invalid maintenance ownership");
export type RuntimeMaintenanceResult = z.infer<typeof runtimeMaintenanceResultSchema>;
export type LocalRuntimeMaintenance = (
  input: RuntimeMaintenanceParams,
) => Promise<RuntimeMaintenanceResult>;
