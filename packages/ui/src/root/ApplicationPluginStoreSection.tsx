import { createContext, useContext, type ReactNode } from "react";
import type { ApplicationPageContext } from "@/root/ApplicationPages.js";

/** Trusted application catalog projection; native services retain install authority. */
export interface ApplicationPluginStoreSection {
  label: string;
  marketplaceIds: readonly string[];
  onRefresh: () => void;
  render: (
    context: ApplicationPageContext & {
      query: string;
      onInstalled: () => Promise<void>;
    },
  ) => ReactNode;
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
