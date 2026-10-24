import { describe, it, expect } from "vitest";
import type { ModelSelectionFacade } from "@zcode/provider";
import { continuationModelValidator } from "../src/zcode-protocol/continuation-model.js";
const selection = { providerId: "personal", modelId: "same-model" };
function validator(
  supportsImage: boolean,
  effective = selection,
  selectionIssue: unknown = undefined,
) {
  return continuationModelValidator({
    getView: () => ({
      effectiveSelection: effective,
      selectionIssue,
      providers: [
        {
          providerId: "personal",
          models: [
            {
              modelId: "same-model",
              config: { properties: { inputFormat: { supportsText: true, supportsImage } } },
            },
          ],
        },
      ],
    }),
  } as Pick<ModelSelectionFacade, "getView">);
}
describe("continuation capability uses the exact target provider view", () => {
  it("refuses the same model name when target image capability differs", () => {
    expect(validator(true)(selection, ["image/png"])).toBe(true);
    expect(validator(false)(selection, ["image/png"])).toBe(false);
    expect(validator(false)(selection)).toBe(true);
  });
  it("never treats automatic replacement or invalid model selection as portable", () => {
    expect(validator(true, { providerId: "replacement", modelId: "same-model" })(selection)).toBe(
      false,
    );
    expect(validator(true, selection, { code: "disabled" })(selection)).toBe(false);
  });
});
