/** Only native owners identify configuration errors; unknown failures retry. */
export class AutomationDispatchConfigurationError extends Error {
  constructor(readonly reason: "model_selection_unavailable" | "target_host_unavailable") {
    super(
      reason === "model_selection_unavailable"
        ? "Automation 模型选择不可用，请重新选择模型与思考档位"
        : "Automation target requires a different Host",
    );
    this.name = "AutomationDispatchConfigurationError";
  }
}

export function describeAutomationDispatchFailure(error: unknown): {
  failureKind: "transient" | "permanent";
  reason: "model_selection_unavailable" | "target_host_unavailable" | "native_dispatch_failed";
} {
  // 临时断连和服务尚未就绪不能停用循环规则；只接受 owner 的明确配置错误。
  return error instanceof AutomationDispatchConfigurationError
    ? { failureKind: "permanent", reason: error.reason }
    : { failureKind: "transient", reason: "native_dispatch_failed" };
}
