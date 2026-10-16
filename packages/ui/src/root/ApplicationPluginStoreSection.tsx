import { createContext, useContext, type ReactNode } from "react";
import type { ApplicationPageContext } from "@/root/ApplicationPages.js";

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
