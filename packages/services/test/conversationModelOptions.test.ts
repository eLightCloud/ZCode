import { expect, it, vi } from "vitest";
import type { ModelSelectionView, ModelSelectionViewInput } from "@zcode/provider";
import { conversationModelOptions } from "#src/session/conversationModelOptions.js";

it("projects only exact executable selections and never forwards provider configuration or preferences", async () => {
  const view = {
    revision: 1,
    preferredSelection: { providerId: "personal", modelId: "disabled" },
    providers: [
      {
        providerId: "personal",
        providerName: "Private provider",
        config: { secret: "SYNTHETIC_NEVER_EXPORT_CONFIG" },
        models: [
          {
            modelId: "exact",
            config: { optionSpecs: { reasoningLevel: { values: ["disabled", "unsupported"] } } },
          },
          { modelId: "disabled", config: {} },
        ],
      },
    ],
  } as unknown as ModelSelectionView;
  const getView = vi.fn(async (input?: ModelSelectionViewInput) =>
    input
      ? ({
          ...view,
          ...(input.selection?.modelId === "exact" &&
          input.selection.options?.reasoningLevel === "disabled"
            ? { effectiveSelection: input.selection }
            : { effectiveSelection: null, selectionIssue: "model-not-found" }),
        } as ModelSelectionView)
      : view,
  );
  expect(await conversationModelOptions({ getView })).toEqual([
    {
      label: "Private provider / exact (disabled)",
      selection: {
        providerId: "personal",
        modelId: "exact",
        options: { reasoningLevel: "disabled" },
      },
    },
  ]);
  expect(JSON.stringify(await conversationModelOptions({ getView }))).not.toContain(
    "SYNTHETIC_NEVER_EXPORT_CONFIG",
  );
});
