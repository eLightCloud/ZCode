/** Only native owners identify configuration errors; unknown failures retry. */
export class AutomationDispatchConfigurationError extends Error {
  constructor(
    readonly reason:
      | "model_selection_unavailable"
      | "target_host_unavailable"
      | "application_admission_denied"
      | "application_authorization_required",
  ) {
    super(
      reason === "application_authorization_required"
        ? "application_authorization_required"
        : reason === "model_selection_unavailable"
          ? "Automation 模型选择不可用，请重新选择模型与思考档位"
          : reason === "application_admission_denied"
            ? "Application admission denied"
            : "Automation target requires a different Host",
    );
    this.name = "AutomationDispatchConfigurationError";
  }
}

/** A retryable failure before input admission; never expose the underlying provider response. */
export class AutomationSessionPreparationError extends Error {
  constructor(readonly reason: "session_resume_failed" | "session_configuration_failed") {
    super(reason);
    this.name = "AutomationSessionPreparationError";
  }
}

export function describeAutomationDispatchFailure(error: unknown): {
  failureKind: "transient" | "permanent";
  reason:
    | "model_selection_unavailable"
    | "target_host_unavailable"
    | "application_admission_denied"
    | "application_authorization_required"
    | "session_resume_failed"
    | "session_configuration_failed"
    | "native_dispatch_failed";
} {
  // 临时断连和服务尚未就绪不能停用循环规则；只接受 owner 的明确配置错误。
  return error instanceof AutomationDispatchConfigurationError
    ? { failureKind: "permanent", reason: error.reason }
    : {
        failureKind: "transient",
        reason:
          error instanceof AutomationSessionPreparationError
            ? error.reason
            : "native_dispatch_failed",
      };
}
