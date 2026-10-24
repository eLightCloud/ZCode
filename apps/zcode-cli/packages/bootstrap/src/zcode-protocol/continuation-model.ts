import type { ModelSelection } from "@zcode/contracts";
import type { ModelSelectionFacade } from "@zcode/provider";
/** Current native provider view owns capability checks; there is no replacement-model fallback. */
export function continuationModelValidator(
  modelSelectionFacade: Pick<ModelSelectionFacade, "getView">,
) {
  return (selection: ModelSelection, mimeTypes: readonly string[] = []) => {
    const view = modelSelectionFacade.getView(undefined, undefined, { selection });
    const model = view.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((model) => model.modelId === selection.modelId);
    const format = model?.config.properties?.inputFormat;
    const filesSupported = mimeTypes.every((value) => {
      const mime = value.split(";")[0]!.trim().toLowerCase();
      return mime.startsWith("image/")
        ? format?.supportsImage === true
        : mime === "application/pdf"
          ? format?.supportsPdf === true
          : mime.startsWith("video/")
            ? format?.supportsVideo === true
            : mime.startsWith("audio/")
              ? format?.supportsAudio === true
              : mime.startsWith("text/")
                ? format?.supportsText === true
                : false;
    });
    return (
      !!view.effectiveSelection &&
      !view.selectionIssue &&
      view.effectiveSelection.providerId === selection.providerId &&
      view.effectiveSelection.modelId === selection.modelId &&
      filesSupported
    );
  };
}
