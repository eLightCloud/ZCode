// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  WorkspaceSidebarFooterUsageSummaryContent,
  type WorkspaceSidebarFooterUsageSummaryState,
} from "@/WorkspaceSidebarFooterUsageSummary.js";
import {
  ApplicationPeripheralsProvider,
  type ApplicationPeripherals,
} from "@/root/ApplicationPeripherals.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/settings/CodingPlanEntryButton.js", () => ({
  useCodingPlanEntryGate: () => ({ status: "ready" }),
}));
vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) =>
    createElement("button", { onClick: onSelect }, children),
}));

afterEach(cleanup);

const state: WorkspaceSidebarFooterUsageSummaryState = {
  audience: undefined,
  availableCodingPlanProviders: [],
  providerSourcesLoading: false,
  providerEntitlements: [],
  profilePlanBadge: null,
  selectedProviderId: undefined,
  upgradeTargetProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  usageState: null,
};

it("omits the native upgrade action in application menus while keeping usage navigation", () => {
  const onUsageClick = vi.fn();
  const onUpgradeClick = vi.fn();
  const peripherals: ApplicationPeripherals = {
    nativeCloudEnabled: false,
    openHelp: vi.fn(),
    openFeedback: vi.fn(),
    openShare: vi.fn(),
    renderModelPlans: () => null,
  };
  render(
    createElement(ApplicationPeripheralsProvider, {
      value: peripherals,
      children: createElement(WorkspaceSidebarFooterUsageSummaryContent, {
        state,
        onUsageClick,
        onUpgradeClick,
      }),
    }),
  );
  expect(screen.queryByRole("button", { name: "sidebar.usage.plan.upgrade" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "sidebar.usage.plan.openStats" }));
  expect(onUsageClick).toHaveBeenCalledOnce();
  expect(onUpgradeClick).not.toHaveBeenCalled();
});

it("retains native upgrade navigation without an application override", () => {
  const onUpgradeClick = vi.fn();
  render(createElement(WorkspaceSidebarFooterUsageSummaryContent, { state, onUpgradeClick }));
  fireEvent.click(screen.getByRole("button", { name: "sidebar.usage.plan.upgrade" }));
  expect(onUpgradeClick).toHaveBeenCalledWith(state.upgradeTargetProviderId, expect.any(Object));
});
