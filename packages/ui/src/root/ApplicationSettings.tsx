import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  addPendingSettingsSectionListener,
  setPendingSettingsSection,
} from "@/lib/settingsNavigation.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { logger } from "@/logger.js";

type SettingsIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
export interface ApplicationSettingsNavigation {
  openModelEntry: (id: string) => void;
}
export interface ApplicationSettingsSection {
  id: string;
  label: string;
  Icon: SettingsIcon;
  group: "basics" | { id: string; label: string };
  render: (navigation: ApplicationSettingsNavigation) => ReactNode;
}
export interface ApplicationModelEntry {
  id: string;
  label: string;
  Icon: SettingsIcon;
  render: (navigation: { openCustomModels: () => void }) => ReactNode;
}
export interface ApplicationSettings {
  sections?: readonly ApplicationSettingsSection[];
  modelEntries?: readonly ApplicationModelEntry[];
}
interface SettingsContext extends ApplicationSettingsNavigation {
  sections: readonly ApplicationSettingsSection[];
  modelEntries: readonly ApplicationModelEntry[];
  section?: ApplicationSettingsSection;
  modelEntry?: ApplicationModelEntry;
  selectSection: (id: string | null) => void;
  selectModelEntry: (id: string | null) => void;
}
const Context = createContext<SettingsContext | undefined>(undefined);
const EMPTY_SECTIONS: readonly ApplicationSettingsSection[] = [];
const EMPTY_ENTRIES: readonly ApplicationModelEntry[] = [];

/** UI selection only. Identity, provider configuration and budgets stay with their owners. */
export function ApplicationSettingsProvider({
  settings,
  children,
}: {
  settings?: ApplicationSettings;
  children: ReactNode;
}) {
  const sections = settings?.sections ?? EMPTY_SECTIONS;
  const modelEntries = settings?.modelEntries ?? EMPTY_ENTRIES;
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [modelEntryId, setModelEntryId] = useState<string | null | undefined>(undefined);
  const selectSection = useCallback((id: string | null) => {
    setSectionId(id);
    if (id) logger.info("application.settings.selected", { sectionId: id });
  }, []);
  const selectModelEntry = useCallback((id: string | null) => {
    setModelEntryId(id);
    logger.info("application.model_entry.selected", { entryId: id, outcome: "selected" });
  }, []);
  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        // 设置关闭期间也接纳原生精确跳转，避免残留企业分区遮住模型或快捷键入口。
        setSectionId(null);
        if (section === "modelProvider" && detail?.modelProviderId) setModelEntryId(null);
      }),
    [],
  );
  const openModelEntry = useCallback(
    (id: string) => {
      if (!modelEntries.some((entry) => entry.id === id)) return;
      setSectionId(null);
      selectModelEntry(id);
      setPendingSettingsSection("modelProvider");
    },
    [modelEntries, selectModelEntry],
  );
  const value = useMemo(
    () => ({
      sections,
      modelEntries,
      section: sections.find((section) => section.id === sectionId),
      modelEntry: modelEntries.find(
        (entry) => entry.id === (modelEntryId === undefined ? modelEntries[0]?.id : modelEntryId),
      ),
      selectSection,
      selectModelEntry,
      openModelEntry,
    }),
    [
      sections,
      modelEntries,
      sectionId,
      modelEntryId,
      selectSection,
      selectModelEntry,
      openModelEntry,
    ],
  );
  return <Context value={value}>{children}</Context>;
}
export function useApplicationSettings() {
  return useContext(Context);
}

export function ApplicationSettingsContent() {
  const settings = useApplicationSettings();
  if (!settings?.section) return null;
  return (
    <ScopedErrorBoundary
      key={settings.section.id}
      scope={`application-settings:${settings.section.id}`}
    >
      {settings.section.render({
        openModelEntry: settings.openModelEntry,
      })}
    </ScopedErrorBoundary>
  );
}
