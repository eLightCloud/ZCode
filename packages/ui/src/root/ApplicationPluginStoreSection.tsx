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

export interface ApplicationPluginStoreSection {
  label: string;
  marketplaceIds: readonly string[];
  onRefresh: () => void;
  render: ApplicationPluginStoreRender;
  renderPublic?: ApplicationPluginStoreRender;
  renderPersonal?: ApplicationPluginStoreRender;
  /** Trusted, optional effect at the resolved active location; owns no native state. */
  renderLocationEffect?: (context: ApplicationPageContext) => ReactNode;
  /** Build-owned discovery grouping only; authorization remains with the catalog server. */
  publicMarketplaceIds?: readonly string[];
  managedMarketplacePrefix?: string;
}

const Context = createContext<ApplicationPluginStoreSection | undefined>(
  undefined,
);
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
