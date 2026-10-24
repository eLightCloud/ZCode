import { isDeepStrictEqual } from "node:util";
import { conversationModelOptionSchema, type ConversationModelOption } from "@zcode/shared";
import type { ConversationModelSelectionReader } from "./contract.js";

/** Project the existing native selection facade; never export provider configuration. */
export async function conversationModelOptions(service: ConversationModelSelectionReader) {
  const view = await service.getView();
  const result: ConversationModelOption[] = [];
  for (const provider of view.providers) {
    for (const model of provider.models) {
      const levels = model.config.optionSpecs?.reasoningLevel?.values;
      for (const level of levels?.length ? levels : [undefined]) {
        const selection = {
          providerId: provider.providerId,
          modelId: model.modelId,
          ...(level ? { options: { reasoningLevel: level } } : {}),
        };
        const current = await service.getView({ selection });
        if (current.selectionIssue || !isDeepStrictEqual(current.effectiveSelection, selection))
          continue;
        result.push(
          conversationModelOptionSchema.parse({
            selection,
            label: `${provider.providerName ?? provider.providerId} / ${model.modelId}${level ? ` (${level})` : ""}`,
          }),
        );
        if (result.length > 500) throw new Error("continuation_model_options_limit");
      }
    }
  }
  return result;
}
