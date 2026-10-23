// ============================================================
// Permission Service - Permission checking and decision making
// ============================================================

import { type RiskLevel } from "@zcode/contracts";

import * as implementation3 from "./permission-capabilities.js";
import * as implementation0 from "./permission-decision.js";
import type { PermissionDecisionResult } from "./permission-service-contract.js";
export interface PermissionServiceApi {
  checkPermission(
    ...args: Parameters<typeof implementation0.checkPermission>
  ): PermissionDecisionResult;
  requiresApproval(...args: Parameters<typeof implementation3.requiresApproval>): boolean;
  getRiskLevel(...args: Parameters<typeof implementation3.getRiskLevel>): RiskLevel;
}
