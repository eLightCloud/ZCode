import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ApplicationPage } from "@/root/ApplicationPages.js";
import { logger } from "@/logger.js";

export interface ApplicationPageNavigationState {
  pages: readonly ApplicationPage[];
  sidebarPages: readonly ApplicationPage[];
  dialogPages: readonly ApplicationPage[];
  selectedPageId: string | null;
  openPage(id: string): void;
  closePage(): void;
  refreshPage(): void;
  generation: number;
}

const ApplicationPageNavigationContext = createContext<ApplicationPageNavigationState | null>(
  null,
);

export function useApplicationPageNavigationState(): ApplicationPageNavigationState | null {
  return useContext(ApplicationPageNavigationContext);
}

/** 受信装配注册的侧栏页面按 sidebarOrder 升序、同值按注册顺序稳定排序。 */
export function selectSidebarPages(pages: readonly ApplicationPage[]): readonly ApplicationPage[] {
  return pages
    .map((page, index) => ({ page, index }))
    .filter((entry) => typeof entry.page.sidebarOrder === "number")
    .sort((a, b) => (a.page.sidebarOrder ?? 0) - (b.page.sidebarOrder ?? 0) || a.index - b.index)
    .map((entry) => entry.page);
}

/** 单一导航 owner：侧栏按钮、Dialog、页面内导航与深链意图共享同一选中态。 */
export function ApplicationPageNavigationProvider({
  pages,
  children,
}: {
  pages: readonly ApplicationPage[];
  children: ReactNode;
}) {
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const sidebarPages = useMemo(() => selectSidebarPages(pages), [pages]);
  const dialogPages = useMemo(
    () => pages.filter((page) => page.sidebarOrder === undefined),
    [pages],
  );
  const selectedPage = useMemo(
    () => pages.find((page) => page.id === selectedPageId) ?? null,
    [pages, selectedPageId],
  );
  const openPage = useCallback(
    (id: string) => {
      if (!pages.some((page) => page.id === id)) return;
      if (!selectedPageId || !returnFocus.current?.isConnected)
        returnFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSelectedPageId(id);
      logger.info("application.page.opened", { pageId: id });
    },
    [pages, selectedPageId],
  );
  const closePage = useCallback(() => {
    logger.info("application.page.closed", { pageId: selectedPageId });
    restoreFocus.current = true;
    setSelectedPageId(null);
  }, [selectedPageId]);
  useLayoutEffect(() => {
    if (selectedPageId !== null || !restoreFocus.current) return;
    // 小屏侧栏先随提交恢复可见，再还原触发焦点；同步 focus 会命中仍隐藏的按钮。
    restoreFocus.current = false;
    if (returnFocus.current?.isConnected) returnFocus.current.focus();
  }, [selectedPageId]);
  const refreshPage = useCallback(() => {
    setGeneration((value) => value + 1);
    logger.info("application.page.refreshed", { pageId: selectedPageId });
  }, [selectedPageId]);
  const state = useMemo<ApplicationPageNavigationState>(
    () => ({
      pages,
      sidebarPages,
      dialogPages,
      selectedPageId,
      openPage,
      closePage,
      refreshPage,
      generation,
    }),
    [pages, sidebarPages, dialogPages, selectedPageId, openPage, closePage, refreshPage, generation],
  );
  useEffect(() => {
    // 注册清单变化后选中页可能消失（如装配热更新）；不得悬挂失效引用。
    if (selectedPageId && !selectedPage) closePage();
  }, [selectedPage, selectedPageId, closePage]);
  return (
    <ApplicationPageNavigationContext.Provider value={state}>
      {children}
    </ApplicationPageNavigationContext.Provider>
  );
}
