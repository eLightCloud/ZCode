import type { PermissionServiceContext } from "./permission-context.js";
import type { PermissionServiceApi } from "./permission-api.js";
import * as implementation3 from "./permission-capabilities.js";
import * as implementation0 from "./permission-decision.js";
import * as implementation2 from "./permission-modes.js";
import * as implementation1 from "./permission-rules.js";
// ============================================================
// Permission Service - Permission checking and decision making
// ============================================================

import { type PermissionUpdate } from "@zcode/contracts";

import { applyPermissionUpdates } from "./rule-updates.js";

import { defaultPermissionConfig } from "./permission-service-contract.js";

import type { PermissionConfig } from "./permission-service-contract.js";

export { defaultPermissionConfig } from "./permission-service-contract.js";

export type {
  PermissionBehavior,
  PermissionConfig,
  PermissionContext,
  PermissionDecisionResult,
  PermissionToolCapability,
} from "./permission-service-contract.js";

// -----------------------------------------------
// Permission Service
// -----------------------------------------------

export class PermissionService {
  /**
   * 会话级 allow 规则（「Always allow in this session」）。
   * 一个实例 = 一个 app = 一个会话，所以"随会话消亡"不需要任何额外机制：重启 / 冷恢复 / `/new`
   * 都会造一个空的新实例。只服务 alwaysAsk gate（见 checkAlwaysAsk），普通工具的模式语义不认它。
   */
  private sessionRules: PermissionServiceContext["sessionRules"] = { version: 1 };

  constructor(private config: PermissionConfig = defaultPermissionConfig) {}

  grantSessionPermission(updates: PermissionUpdate[]): void {
    this.sessionRules = applyPermissionUpdates(this.sessionRules, updates);
  }

  declare private matchesProjectRules: OmitThisParameter<
    typeof implementation1.matchesProjectRules
  >;

  declare private matchesRule: OmitThisParameter<typeof implementation1.matchesRule>;

  declare private matchesRuleToolName: OmitThisParameter<
    typeof implementation1.matchesRuleToolName
  >;

  declare private matchesRuleScope: OmitThisParameter<typeof implementation1.matchesRuleScope>;

  declare private ruleSubjects: OmitThisParameter<typeof implementation1.ruleSubjects>;

  declare private isPreapprovedWebFetchRequest: OmitThisParameter<
    typeof implementation1.isPreapprovedWebFetchRequest
  >;

  declare private matchesRuleContent: OmitThisParameter<typeof implementation1.matchesRuleContent>;

  /**
   * 工具自报 alwaysAsk 时的判定：ask 压过所有"放行"分支（yolo 直通、plan 的 readOnly 直通），
   * 但**压不过"阻断"**——所以这里先自己走一遍硬阻断判定。
   *
   * 为什么不直接返回 ask：disallowedTools 是用户配置的硬禁用，项目 deny 规则符合工具自报的
   * denyPriority: "beforeAsk"，auto 模式是"该模式未实现"的保护。少了这一步，一个被硬禁用的
   * 工具会退化成"弹个窗、用户一点就能跑"。
   *
   * 这些判定在 checkPermission 里按原有顺序还会各自出现一次；此处刻意只覆盖 alwaysAsk 工具，
   * 不改动其他工具的既有优先级（尤其 yolo 目前先于 disallowedTools 放行这一点）。
   */
  declare private checkAlwaysAsk: OmitThisParameter<typeof implementation2.checkAlwaysAsk>;

  /**
   * AmendWorkflow 且回填的 `predecessor` 说「本会话的 run、非用户停下」；或 FillWorkflowHole 且回填的
   * `hole` 说同一件事（docs/dynamic-workflow/launch.md「Approval」：补全是对一个在飞 run 脚本的修订，
   * 由同一条 amend 规则判定）。
   */
  declare private isOwnedWorkflowAmend: OmitThisParameter<
    typeof implementation2.isOwnedWorkflowAmend
  >;

  declare private checkPlanMode: OmitThisParameter<typeof implementation2.checkPlanMode>;

  declare private isMcpToolCapability: OmitThisParameter<
    typeof implementation2.isMcpToolCapability
  >;

  declare private checkBuildMode: OmitThisParameter<typeof implementation2.checkBuildMode>;

  declare private checkEditMode: OmitThisParameter<typeof implementation2.checkEditMode>;

  declare private isReadOnlyTool: OmitThisParameter<typeof implementation3.isReadOnlyTool>;

  declare private isWriteTool: OmitThisParameter<typeof implementation3.isWriteTool>;

  declare private isDestructiveTool: OmitThisParameter<typeof implementation3.isDestructiveTool>;

  declare private resolveCapability: OmitThisParameter<typeof implementation3.resolveCapability>;

  declare private allow: OmitThisParameter<typeof implementation3.allow>;

  declare private ask: OmitThisParameter<typeof implementation3.ask>;

  declare private deny: OmitThisParameter<typeof implementation3.deny>;

  declare private result: OmitThisParameter<typeof implementation3.result>;
}

export interface PermissionService extends PermissionServiceApi {}

// 与 owner 共享原型和 this；保持方法不可枚举，clone/继承沿原路径工作。
for (const methods of [implementation0, implementation1, implementation2, implementation3]) {
  for (const [name, value] of Object.entries(methods)) {
    Object.defineProperty(PermissionService.prototype, name, {
      value,
      writable: true,
      configurable: true,
    });
  }
}
