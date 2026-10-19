import {
  isZCodeAgentProvider,
  resolveModelProviderFamilySpecByProviderId,
  zcodeProviderAccountAccessSchema,
  type ZCodeProviderAccountAccess,
  type ZCodeProvider,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { shouldShowModelVisionBadge } from "@/lib/modelVisionBadge.js";

export interface ModelProviderGroupLabelOptions {
  apiKeyLabel?: string;
  apiKeyBadgeLabel?: string;
  codingPlanLabel?: string;
  codingPlanBadgeLabel?: string;
  startPlanLabel?: string;
  startPlanBadgeLabel?: string;
  teamPlanBadgeLabel?: string;
  teamPlanFallbackLabel?: string;
}

function supportsRegistryApiFormat(
  selectedProvider: ZCodeProvider,
  apiFormat: string | null | undefined,
): boolean {
  if (!apiFormat) return false;
  // 仅剩 glm（ZCode Agent）provider；三方 CLI 的 api format 差异已随 provider 下线。
  return isZCodeAgentProvider(selectedProvider);
}

export function buildRegistryModelSelectGroups(
  selectedProvider: ZCodeProvider,
  view: ModelSelectionView | null | undefined,
  labels: ModelProviderGroupLabelOptions = {},
): ModelSelectGroup[] {
  const providers = view?.providers ?? [];
  const groups = providers.flatMap((provider) => {
    if (!supportsRegistryApiFormat(selectedProvider, provider.config.api?.type)) {
      return [];
    }

    const accountAccess = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    const accountPresentation = accountAccess.success
      ? getRegistryAccountProviderGroupPresentation(provider.providerId, accountAccess.data, labels)
      : null;

    return [
      {
        key: `registry-provider:${provider.providerId}`,
        label: accountPresentation?.label || provider.providerName?.trim() || provider.providerId,
        ...(accountPresentation?.labelBadge ? { labelBadge: accountPresentation.labelBadge } : {}),
        ...(accountPresentation ? { directItems: true } : {}),
        items: provider.models.map(({ modelId, config }) => ({
          key: `registry-provider:${provider.providerId}:${modelId}`,
          value: encodeCustomModelValue(provider.providerId, modelId),
          name: modelId,
          ...(provider.config.logo ? { logo: provider.config.logo } : {}),
          ...(provider.config.group === "application-managed"
            ? /^claude-/i.test(modelId)
              ? { logo: { type: "builtin" as const, key: "anthropic" } }
              : /^gpt-/i.test(modelId)
                ? { logo: { type: "builtin" as const, key: "openai" } }
                : /^minimax-/i.test(modelId)
                  ? { logo: { type: "builtin" as const, key: "minimax" } }
                  : {}
            : {}),
          ...(shouldShowModelVisionBadge(
            modelId,
            config.properties?.inputFormat?.supportsImage,
            provider.config.access,
          )
            ? { supportsVisionInput: true }
            : {}),
        })),
      },
    ];
  });
  // 没有可执行 Provider 时 Registry 会移除它，不能据此隐藏系统 / 自定义分区。
  const system: ModelSelectGroup = {
    key: "application-models:system",
    label: "System models",
    directItems: true,
    items: [],
  };
  const personal: ModelSelectGroup = {
    key: "application-models:personal",
    label: "Custom models",
    directItems: true,
    items: [],
  };
  const other: ModelSelectGroup[] = [];
  for (const group of groups) {
    const provider = providers.find(
      (candidate) => `registry-provider:${candidate.providerId}` === group.key,
    )!;
    if (provider.config.group === "application-managed") system.items.push(...group.items);
    else if (provider.config.group === "standard-personal")
      personal.items.push(
        ...group.items.map((item) => ({
          ...item,
          badgeLabel: provider.providerName?.trim() || provider.providerId,
        })),
      );
    else other.push(group);
  }
  // 空态也保留分区，首次使用者才能发现自定义 Provider 的添加入口。
  return [system, personal, ...other.filter((group) => group.items.length > 0)];
}

function getRegistryAccountProviderGroupPresentation(
  providerId: string,
  access: ZCodeProviderAccountAccess,
  labels: ModelProviderGroupLabelOptions,
): Pick<ModelSelectGroup, "label" | "labelBadge"> {
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  const label = familySpec?.label ?? providerId;
  if (access.mode === "start-plan") {
    return { label: "Start Plan", labelBadge: labels.startPlanBadgeLabel ?? "Free" };
  }
  if (access.mode === "team-coding-plan") {
    return { label, labelBadge: labels.teamPlanBadgeLabel ?? "Team" };
  }
  return { label, labelBadge: labels.codingPlanBadgeLabel ?? "Individual" };
}

export function resolveModelDisplayName(
  modelGroups: readonly ModelSelectGroup[],
  value: string,
): string | null {
  for (const group of modelGroups) {
    const matched = group.items.find((item) => item.value === value);
    if (matched) return matched.name;
  }

  return decodeCustomModelValue(value)?.modelName ?? null;
}
