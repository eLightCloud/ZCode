import type { WorkspaceHookReviewControllerMethodsContext } from "./hook-review-context.js";
import { WorkspaceHookReviewFlowRegistry, type WorkspaceHookReviewFlow } from "@zcode/core";
import type { WorkspaceHookReviewControllerApi } from "./hook-review-api.js";
import { installWorkspaceHookReviewControllerMethods } from "./hook-review-methods.js";
import type * as implementation3 from "./hook-review-persistence.js";
import type * as implementation0 from "./hook-review-request.js";
import { WorkspaceHookReviewTelemetry } from "./workspace-hook-review-telemetry.js";
import type { WorkspaceHookReviewControllerOptions } from "./workspace-hook-review-types.js";

export type * from "./workspace-hook-review-types.js";

export class WorkspaceHookReviewController {
  // 类型声明无实例字段；实现由下方唯一安装器登记在同一 owner 原型。
  declare requestReview: WorkspaceHookReviewControllerApi["requestReview"];
  declare respond: WorkspaceHookReviewControllerApi["respond"];
  declare toggle: WorkspaceHookReviewControllerApi["toggle"];
  declare revoke: WorkspaceHookReviewControllerApi["revoke"];
  declare revokeCurrent: WorkspaceHookReviewControllerApi["revokeCurrent"];

  private readonly admission: WorkspaceHookReviewControllerMethodsContext["admission"];
  private readonly appVersion?: WorkspaceHookReviewControllerMethodsContext["appVersion"];
  private readonly coordinator: WorkspaceHookReviewControllerMethodsContext["coordinator"];
  private readonly host: WorkspaceHookReviewControllerMethodsContext["host"];
  private readonly telemetry: WorkspaceHookReviewControllerMethodsContext["telemetry"];
  private readonly mutation: WorkspaceHookReviewControllerMethodsContext["mutation"];
  private readonly sessionId: WorkspaceHookReviewControllerMethodsContext["sessionId"];
  private readonly store: WorkspaceHookReviewControllerMethodsContext["store"];
  private readonly now: WorkspaceHookReviewControllerMethodsContext["now"];
  private readonly createId: WorkspaceHookReviewControllerMethodsContext["createId"];
  private readonly registry: WorkspaceHookReviewControllerMethodsContext["registry"] =
    new WorkspaceHookReviewFlowRegistry();
  /** flow → 监管 promise。WeakMap 使 flow 被回收后自动移除，不额外持有引用。 */
  private readonly supervisedFlows: WorkspaceHookReviewControllerMethodsContext["supervisedFlows"] =
    new WeakMap<WorkspaceHookReviewFlow, Promise<void>>();
  private reviewFlowId?: WorkspaceHookReviewControllerMethodsContext["reviewFlowId"];
  private generation: WorkspaceHookReviewControllerMethodsContext["generation"] = 0;
  private mutationQueue: WorkspaceHookReviewControllerMethodsContext["mutationQueue"] =
    Promise.resolve();

  constructor(options: WorkspaceHookReviewControllerOptions) {
    this.admission = options.admission;
    this.appVersion = options.appVersion;
    this.coordinator = options.coordinator;
    this.host = options.host;
    this.telemetry = new WorkspaceHookReviewTelemetry(this.admission, options.logger);
    this.mutation = options.mutation;
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  /**
   * 见 workspace-hook-review-supervisor：任何新开 flow 都必须交由它监管。
   *
   * openOrReuseFlow 会复用仍 pending 的同一 flow
   * 对象，因此重复 requestReview 与 revoke 重开路径可能给同一个 flow 各挂一个 supervisor，
   * timeout 时重复 emit ReviewSettled。重复监管与缺监管同病：
   * 按 flow 对象单例化，重复请求直接复用已有的监管 promise。
   */
  declare private superviseFlow: OmitThisParameter<typeof implementation0.superviseFlow>;

  /**
   * 软门禁:按需开审核 flow。
   *
   * 用户点击「去审核」时经 requestWorkspaceHookReview 命令调用。
   * 无 pending 项时为安全 no-op(返回 accepted)。
   * 已有活跃 flow 时幂等复用(openOrReuseFlow)。
   * 必须经 superviseFlow 监管——否则 flow 超时后会静默死亡、面板永久失效。
   */

  declare private refreshPendingFlow: OmitThisParameter<typeof implementation0.refreshPendingFlow>;

  /**
   * revoke 之后当前会话没有 pending flow 时，重新开启审核。
   *
   * 只在真的存在待审项时开启。开关只控制运行，信任只控制准入；因此当前审核
   * 快照中的 configured-disabled 声明也必须保留行内信任入口。开启走
   * openOrReuseFlow，与首次征询同一条路径，因此 generation / reviewFlowId /
   * interactionId 的既有语义不变。
   */
  declare private openReviewFlowForNewPendingItems: OmitThisParameter<
    typeof implementation0.openReviewFlowForNewPendingItems
  >;

  declare private openOrReuseFlow: OmitThisParameter<typeof implementation0.openOrReuseFlow>;

  declare private buildRequest: OmitThisParameter<typeof implementation0.buildRequest>;

  declare private applyPersistentTrust: OmitThisParameter<
    typeof implementation3.applyPersistentTrust
  >;

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 软门禁:mutation 完成后重新评估 pending 状态并发射 AdmissionUpdated。
   *
   * 口径与 admission 一致:configuredEnabled && admissionClass === "pending"。
   * pendingCount === 0 也要发,投影据此清空提示条。
   * 通过 admission 的 invalidate → 触发 evaluateDispatch 内的 refreshEvaluation;
   * 这里直接用 coordinator 重新评估快照,与 admission.emitAdmissionState 同源。
   */
  declare private emitAdmissionUpdatedAfterMutation: OmitThisParameter<
    typeof implementation3.emitAdmissionUpdatedAfterMutation
  >;
}

installWorkspaceHookReviewControllerMethods(WorkspaceHookReviewController.prototype);
