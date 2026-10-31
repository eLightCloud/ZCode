import { createContext, useContext, type ReactNode } from "react";
import type { ApplicationPageContext } from "@/root/ApplicationPages.js";
import { ApplicationPageContent } from "@/root/ApplicationPages.js";

/** Trusted application catalog projection; native services retain install authority. */
export type ApplicationPluginStoreRender = (
  context: ApplicationPageContext & {
    query: string;
    onInstalled: () => Promise<void>;
  },
) => ReactNode;

export interface ApplicationPluginDiscoveryCatalog {
  marketplaceIds: readonly string[];
  entries: readonly {
    pluginId: string;
    group: "public" | "community";
    nameZh?: string;
    nameEn?: string;
  }[];
  loading: boolean;
}

export interface ApplicationPluginStoreSection {
  /** Presentation only; the application server still authorizes every request. */
  visible?: boolean;
  beforeCreate?: (
    segment: "public" | "community" | "personal" | "application",
    workspace: { workspacePath: string; workspaceIdentity?: string },
    host?: import("@zcode/services").IApplicationHostService,
  ) => Promise<void | { promptSuffix: string }>;
  onImport?: (
    segment: "public" | "community" | "personal" | "application",
    workspace: import("@zcode/services").ZCodeAgentWorkspaceTarget,
  ) => void;
  registeredSourcePluginIds?: readonly string[];
  label: string;
  marketplaceIds: readonly string[];
  onRefresh: () => void;
  render: ApplicationPluginStoreRender;
  renderPublic?: ApplicationPluginStoreRender;
  renderCommunity?: ApplicationPluginStoreRender;
  renderPersonal?: ApplicationPluginStoreRender;
  /** Published discovery only; installed state and runtime remain native. */
  catalog?: ApplicationPluginDiscoveryCatalog;
  beforeUninstall?: (pluginId: string) => Promise<void>;
  beforeAcquire?: (pluginId: string) => Promise<void>;
  count?: (segment: "public" | "community" | "personal", query: string) => number;
  /** Trusted, optional effect at the resolved active location; owns no native state. */
  renderLocationEffect?: (context: ApplicationPageContext) => ReactNode;
  /** Build-owned discovery grouping only; authorization remains with the catalog server. */
  publicMarketplaceIds?: readonly string[];
  managedMarketplacePrefix?: string;
}

const Context = createContext<ApplicationPluginStoreSection | undefined>(undefined);
export function ApplicationPluginStoreProvider({
  section,
  children,
}: {
  section?: ApplicationPluginStoreSection;
  children: ReactNode;
}) {
  return <Context value={section}>{children}</Context>;
}
export function useApplicationPluginStoreSection() {
  return useContext(Context);
}

export function ApplicationPluginLocationEffect() {
  const section = useApplicationPluginStoreSection();
  return section?.renderLocationEffect ? (
    <ApplicationPageContent render={section.renderLocationEffect} />
  ) : null;
}
