// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutomationCapabilities, formatExecutionTimezone } from "./index.js";
import type { AutomationCapabilities } from "./contract.js";
afterEach(cleanup);

describe("automation execution host capabilities", () => {
  it("invalidates the old host immediately and ignores its late reply", async () => {
    let finish!: (value: AutomationCapabilities) => void;
    const old = { getAutomationCapabilities: () => new Promise<AutomationCapabilities>((resolve) => { finish = resolve; }) };
    const next = { getAutomationCapabilities: vi.fn(async () => ({ manualDispatchAvailable: false, timezone: "UTC" })) };
    const { result, rerender } = renderHook(({ reader }) => useAutomationCapabilities(reader), { initialProps: { reader: old } });
    rerender({ reader: next });
    expect(result.current.state.status).toBe("loading");
    await waitFor(() => expect(result.current.state).toEqual({ status: "ready", value: { manualDispatchAvailable: false, timezone: "UTC" } }));
    await act(async () => finish({ manualDispatchAvailable: true, timezone: "Asia/Shanghai" }));
    expect(result.current.state).toEqual({ status: "ready", value: { manualDispatchAvailable: false, timezone: "UTC" } });
  });
  it("reports unavailable reads, retries only the read, and invalidates on disconnect", async () => {
    const reader = { getAutomationCapabilities: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ manualDispatchAvailable: true, timezone: "Asia/Shanghai" }) };
    const { result, rerender } = renderHook(({ enabled }) => useAutomationCapabilities(reader, enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    rerender({ enabled: false });
    expect(result.current.state.status).toBe("unavailable");
    expect(reader.getAutomationCapabilities).toHaveBeenCalledTimes(2);
  });
  it("shows the execution timezone independently of the browser, including DST", () => {
    expect(formatExecutionTimezone("Asia/Shanghai", Date.UTC(2026, 10, 6))).toBe("Asia/Shanghai (GMT+8)");
    expect(formatExecutionTimezone("UTC", Date.UTC(2026, 10, 6))).toBe("UTC (GMT)");
    expect(formatExecutionTimezone("America/New_York", Date.UTC(2026, 6, 6))).toBe("America/New_York (GMT-4)");
    expect(formatExecutionTimezone("America/New_York", Date.UTC(2026, 0, 6))).toBe("America/New_York (GMT-5)");
  });
});
