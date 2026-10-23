import { z } from "zod";

export const WorkflowKindSchema = z.string().min(1);

export type WorkflowKind = z.infer<typeof WorkflowKindSchema>;

export const WorkflowPhaseIdSchema = z.string().min(1);

export type WorkflowPhaseId = z.infer<typeof WorkflowPhaseIdSchema>;

export const WorkflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const WorkflowNodeStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);

export type WorkflowNodeStatus = z.infer<typeof WorkflowNodeStatusSchema>;

export const WorkflowGraphCollectionStatusSchema = z.enum(["active", "draining", "exhausted"]);

export type WorkflowGraphCollectionStatus = z.infer<typeof WorkflowGraphCollectionStatusSchema>;

export const ExpertWorkflowPhaseSchema = z.enum([
  "clarify",
  "task_analysis",
  "arch_decompose",
  "env_setup",
  "meta_prompt",
  "exec",
  "final_critic",
  "complete",
]);

export type ExpertWorkflowPhase = z.infer<typeof ExpertWorkflowPhaseSchema>;

export const WorkflowStrategySchema = z.object({
  clarify: z.object({
    confidenceThreshold: z.number(),
    maxRounds: z.number().int().positive(),
    minRounds: z.number().int().nonnegative(),
  }),
  executor: z.object({
    drainingChangeHours: z.number().positive(),
    frontierTarget: z.number().int().positive(),
    maxConcurrentLoops: z.number().int().positive(),
    maxConsecutiveErrors: z.number().int().positive(),
    maxPlannerRuns: z.number().int().positive(),
  }),
  finalCritic: z.object({
    maxIterations: z.number().int().positive(),
  }),
  reactLoop: z.object({
    maxRounds: z.number().int().positive(),
  }),
});

export type WorkflowStrategy = z.infer<typeof WorkflowStrategySchema>;

export const ExpertWorkflowStrategySchema = WorkflowStrategySchema;

export type ExpertWorkflowStrategy = WorkflowStrategy;

export const WorkflowPhaseBehaviorSchema = z.enum([
  "agent",
  "scheduled_graph",
  "critic",
  "complete",
]);

export type WorkflowPhaseBehavior = z.infer<typeof WorkflowPhaseBehaviorSchema>;

export const WorkflowGraphSeedSourceSchema = z.object({
  gateAfterPhase: WorkflowPhaseIdSchema.optional(),
  targetPhase: WorkflowPhaseIdSchema,
});

export type WorkflowGraphSeedSource = z.infer<typeof WorkflowGraphSeedSourceSchema>;
