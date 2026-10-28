import { useState, useEffect, type ReactNode } from "react";
import { useApplicationPeripherals } from "@/root/ApplicationPeripherals.js";
import { useApplicationSettings, type ApplicationModelEntry } from "@/root/ApplicationSettings.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON } from "@zcode/shared/test-ids";
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

function ApplicationModelPanel({
  entry,
  active,
}: {
  entry: ApplicationModelEntry;
  active: boolean;
}) {
  const settings = useApplicationSettings();
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  return (
    <TabsContent
      value={`application:${entry.id}`}
      forceMount
      hidden={!active}
      className="mt-5 min-w-0 data-[state=inactive]:hidden"
    >
      {(active || visited) && (
        <ScopedErrorBoundary scope={`application-model:${entry.id}`}>
          {entry.render({
            openCustomModels: () => settings?.selectModelEntry(null),
            openSection: (id) => settings?.openSection(id),
          })}
        </ScopedErrorBoundary>
      )}
    </TabsContent>
  );
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
  const entries = settings?.modelEntries ?? [];
  const refreshButtonLoading = shouldShowModelProviderRefreshLoading({
    presetLoading,
    customLoading,
  });
  const hasProviders = navigationGroups.some((group) => group.items.length > 0);
  const providers = (
    <div className="space-y-4" data-model-source="custom">
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">{description}</p>
        <SettingsResourceHeaderActions
          onRefresh={onRefresh}
          onNew={onAddProvider}
          refreshing={refreshButtonLoading}
          refreshLabel={refreshButtonLoading ? loadingLabel : refreshLabel}
          newLabel={addProviderLabel}
          newTestId={TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON}
        />
      </div>
      <div className="overflow-clip rounded-xl border border-border bg-card">
        <div
          className={
            hasProviders
              ? "grid min-h-[28rem] grid-cols-[56px_minmax(0,1fr)] md:grid-cols-[224px_minmax(0,1fr)]"
              : "min-w-0"
          }
          data-model-provider-split-panel={hasProviders || undefined}
        >
          {hasProviders && (
            <div
              className="min-w-0 border-r border-border"
              data-model-provider-navigation-scroll="true"
            >
              <ModelProviderSectionNavigation
                navigationGroups={navigationGroups}
                selectedNodeKey={selectedNodeKey}
                presetLoading={presetLoading}
                customLoading={customLoading}
                onSelectNavItem={onSelectNavItem}
                onReorderProviderIds={onReorderProviderIds}
                reorderableProviderIds={reorderableProviderIds}
              />
            </div>
          )}
          <div
            className="relative min-w-0 p-4 pb-20 sm:p-6 sm:pb-24"
            data-model-provider-detail-scroll="true"
          >
            <ProviderDetailFeedbackBoundary key={selectedNodeKey ?? "unselected-provider"}>
              {children}
            </ProviderDetailFeedbackBoundary>
          </div>
        </div>
      </div>
    </div>
  );
  if (!entries.length)
    return (
      <div className="space-y-4">
        {peripherals?.renderModelPlans()}
        {providers}
      </div>
    );
  const active = settings?.modelEntry?.id;
  return (
    <Tabs
      value={active ? `application:${active}` : "custom"}
      onValueChange={(value) => {
        const entry = entries.find((item) => `application:${item.id}` === value);
        settings?.selectModelEntry(entry?.id ?? null);
      }}
      className="min-w-0"
      data-model-source-tabs="true"
    >
      <TabsList
        variant="line"
        className="!h-auto min-h-11 w-full justify-start gap-0 border-b border-border p-0"
      >
        {entries.map(({ id, label }) => (
          <TabsTrigger
            key={id}
            value={`application:${id}`}
            className="min-h-11 min-w-0 flex-1 whitespace-normal px-2 leading-normal sm:flex-none sm:whitespace-nowrap sm:px-5"
          >
            {label}
          </TabsTrigger>
        ))}
        <TabsTrigger
          value="custom"
          className="min-h-11 min-w-0 flex-1 whitespace-normal px-2 leading-normal sm:flex-none sm:whitespace-nowrap sm:px-5"
        >
          {intl.formatMessage({ id: "chat.toolbar.model.customModels" })}
        </TabsTrigger>
      </TabsList>
      {entries.map((entry) => (
        <ApplicationModelPanel key={entry.id} entry={entry} active={active === entry.id} />
      ))}
      {/* 保留原生表单挂载，切换来源 Tab 不能丢失尚未保存的供应商配置。 */}
      <TabsContent
        value="custom"
        forceMount
        hidden={!!active}
        className="mt-5 min-w-0 data-[state=inactive]:hidden"
      >
        {providers}
      </TabsContent>
    </Tabs>
  );
}
