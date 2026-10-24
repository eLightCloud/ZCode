import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export interface V4CommandAdmission {
  admissionSeq: number;
  admittedAt: number;
  queueItemId: string;
}

export interface V4CommandExecutionContext {
  /** 内部 auto-drain 必须在 reserve 前由 handler 原子校验 Core idle。 */
  autoDrainPromotion?: true;
}

export type V4AdmittedCommandEnvelope = CommandEnvelope & {
  __v4Admission?: V4CommandAdmission;
  __v4ExecutionContext?: V4CommandExecutionContext;
};

export function commandAdmissionOf(envelope: CommandEnvelope): V4CommandAdmission {
  return (
    (envelope as V4AdmittedCommandEnvelope).__v4Admission ?? {
      admissionSeq: 0,
      admittedAt: Date.now(),
      queueItemId: `queue_${envelope.commandId}`,
    }
  );
}

export function commandExecutionContextOf(
  envelope: CommandEnvelope,
): V4CommandExecutionContext | undefined {
  return (envelope as V4AdmittedCommandEnvelope).__v4ExecutionContext;
}
