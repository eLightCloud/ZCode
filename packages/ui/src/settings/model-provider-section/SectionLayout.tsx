import { useApplicationPeripherals } from "@/root/ApplicationPeripherals.js";
import { useApplicationSettings } from "@/root/ApplicationSettings.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ReactNode } from "react";
import { TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON } from "@zcode/shared";
import type { ModelProviderNavGroup } from "@/settings/model-provider-section/constants.js";
import { ModelProviderSectionNavigation } from "@/settings/model-provider-section/Navigation.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";

interface ModelProviderSectionLayoutProps {
  description: string;
  refreshLabel: string;
  loadingLabel: string;
  presetLoading: boolean;
  customLoading: boolean;
  onRefresh: () => void;
  addProviderLabel: string;
  onAddProvider: () => void;
  navigationGroups: ModelProviderNavGroup[];
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavGroup["items"][number]) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
  children: ReactNode;
}

export function shouldShowModelProviderRefreshLoading(params: {
  presetLoading: boolean;
  customLoading: boolean;
}): boolean {
  return params.presetLoading || params.customLoading;
}

export function ModelProviderSectionLayout({
  description,
  refreshLabel,
  loadingLabel,
  presetLoading,
  customLoading,
  onRefresh,
  addProviderLabel,
  onAddProvider,
  navigationGroups,
  selectedNodeKey,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
  children,
}: ModelProviderSectionLayoutProps) {
  const peripherals = useApplicationPeripherals();
  const { intl } = useZCodeIntl();
  const settings = useApplicationSettings();
  const visibleGroups =
    settings?.modelEntries.length && !navigationGroups.some((group) => group.id === "custom")
      ? [
          ...navigationGroups,
          {
            id: "custom" as const,
            title: intl.formatMessage({ id: "chat.toolbar.model.customModels" }),
            items: [],
          },
        ]
      : navigationGroups;
  const refreshButtonLoading = shouldShowModelProviderRefreshLoading({
    presetLoading,
    customLoading,
  });

  return (
    <div className="space-y-4">
      {!settings?.modelEntries.length ? peripherals?.renderModelPlans() : null}
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">{description}</p>
        <SettingsResourceHeaderActions
          onRefresh={onRefresh}
          onNew={() => {
            settings?.selectModelEntry(null);
            onAddProvider();
          }}
          refreshing={refreshButtonLoading}
          refreshLabel={refreshButtonLoading ? loadingLabel : refreshLabel}
          newLabel={addProviderLabel}
          newTestId={TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON}
        />
      </div>

      <div className="overflow-clip rounded-xl border border-border bg-card">
        <div
          className="grid min-h-[36rem] grid-cols-[56px_minmax(0,1fr)] gap-0 md:grid-cols-[224px_minmax(0,1fr)]"
          data-model-provider-split-panel="true"
        >
          <div
            className="min-w-0 border-r border-border"
            data-model-provider-navigation-scroll="true"
          >
            {settings?.modelEntries.map(({ id, label, Icon }) => (
              <ControlHintTooltip key={id} title={label} side="right">
                <Button
                  variant="ghost"
                  aria-label={label}
                  aria-pressed={settings.modelEntry?.id === id}
                  className="m-2 max-w-full text-ui-base aria-pressed:bg-selected max-md:mx-1 max-md:min-h-11 max-md:min-w-11"
                  onClick={() => settings.selectModelEntry(id)}
                >
                  <Icon className="size-4 shrink-0" aria-hidden={true} />
                  <span className="max-md:sr-only">{label}</span>
                </Button>
              </ControlHintTooltip>
            ))}
            <ModelProviderSectionNavigation
              navigationGroups={visibleGroups}
              showEmptyCustomGroup={Boolean(settings?.modelEntries.length)}
              selectedNodeKey={settings?.modelEntry ? null : selectedNodeKey}
              presetLoading={presetLoading}
              customLoading={customLoading}
              onSelectNavItem={(item) => {
                settings?.selectModelEntry(null);
                onSelectNavItem(item);
              }}
              onReorderProviderIds={onReorderProviderIds}
              reorderableProviderIds={reorderableProviderIds}
            />
          </div>
          <div
            className="relative min-w-0 p-4 pb-20 sm:p-6 sm:pb-24"
            data-model-provider-detail-scroll="true"
          >
            <ProviderDetailFeedbackBoundary
              key={settings?.modelEntry?.id ?? selectedNodeKey ?? "unselected-provider"}
            >
              {settings?.modelEntry ? (
                <ScopedErrorBoundary scope={`application-model:${settings.modelEntry.id}`}>
                  {settings.modelEntry.render()}
                </ScopedErrorBoundary>
              ) : (
                children
              )}
            </ProviderDetailFeedbackBoundary>
          </div>
        </div>
      </div>
      {settings?.modelEntries.length ? peripherals?.renderModelPlans() : null}
    </div>
  );
}
