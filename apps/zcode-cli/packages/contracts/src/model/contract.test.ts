import { describe, expect, it } from "vitest";
import { createModelId, getCurrentModelInvocationContext, runWithModelInvocationContext } from "./index.js";

describe("model protocol public contract", () => {
  it("rejects an empty model identity before a provider can be chosen", () => {
    expect(() => createModelId("")).toThrow();
  });
  it("does not let a derived async stream clear automation credential restrictions", async () => {
    const stream = runWithModelInvocationContext({ modelRequestPurpose: "automation" }, () =>
      runWithModelInvocationContext({}, async function* () {
        await Promise.resolve();
        yield getCurrentModelInvocationContext()?.modelRequestPurpose;
      }),
    );
    expect(getCurrentModelInvocationContext()).toBeUndefined();
    const values: unknown[] = [];
    for await (const value of stream) values.push(value);
    expect(values).toEqual(["automation"]);
    expect(getCurrentModelInvocationContext()).toBeUndefined();
  });
});
