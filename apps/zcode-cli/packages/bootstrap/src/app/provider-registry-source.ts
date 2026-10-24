import {
  type ModelSelection,
  type ModelSelectionValidation,
  type Provider,
  type ProviderModel,
  type ProviderRegistryView,
} from "@zcode/provider";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export interface ProviderRegistryModelSource {
  getView(): ProviderRegistryView;
  getProvider(providerId: string): Provider | undefined;
  getModel(providerId: string, modelId: string): ProviderModel | undefined;
  validateSelection(selection: ModelSelection): ModelSelectionValidation;
  onDidChange(listener: () => void): () => void;
}
