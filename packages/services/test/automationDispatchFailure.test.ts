import { describe, expect, it } from "vitest";
import {
  AutomationDispatchConfigurationError,
  describeAutomationDispatchFailure,
} from "../src/node.js";

describe("native automation failure policy", () => {
  it.each([new Error("network down"), new Error("model_selection_unavailable"), null])(
    "unknown failures stay transient regardless of message: %s",
    (error) => {
      expect(describeAutomationDispatchFailure(error)).toEqual({
        failureKind: "transient",
        reason: "native_dispatch_failed",
      });
    },
  );
  it.each(["model_selection_unavailable", "target_host_unavailable"] as const)(
    "explicit configuration error is permanent: %s",
    (reason) => {
      expect(
        describeAutomationDispatchFailure(new AutomationDispatchConfigurationError(reason)),
      ).toEqual({ failureKind: "permanent", reason });
    },
  );
});
