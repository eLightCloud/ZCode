import { z } from "zod";

import {
  WorkflowGraphSeedSourceSchema,
  WorkflowKindSchema,
  WorkflowPhaseBehaviorSchema,
  WorkflowPhaseIdSchema,
  WorkflowStrategySchema,
} from "./workflow-state.js";

export const WorkflowPhaseDefinitionSchema = z.object({
  artifactPath: z.string().optional(),
  behavior: WorkflowPhaseBehaviorSchema.default("agent"),
  description: z.string().min(1),
  nodePromptsFromArtifact: z
    .object({
      targetPhase: WorkflowPhaseIdSchema,
    })
    .optional(),
  phase: WorkflowPhaseIdSchema,
  seedGraphFromArtifact: WorkflowGraphSeedSourceSchema.optional(),
  title: z.string().min(1),
});

export type WorkflowPhaseDefinition = z.infer<typeof WorkflowPhaseDefinitionSchema>;

export const WorkflowDefinitionSchema = z
  .object({
    definitionId: z.string().min(1),
    definitionVersion: z.string().min(1),
    description: z.string().optional(),
    kind: WorkflowKindSchema,
    phaseOrder: z.array(WorkflowPhaseIdSchema).min(1),
    phases: z.array(WorkflowPhaseDefinitionSchema).min(1),
    strategy: WorkflowStrategySchema,
    title: z.string().min(1),
  })
  .superRefine((definition, context) => {
    const seenPhases = new Set<string>();
    for (const phase of definition.phases) {
      if (seenPhases.has(phase.phase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate workflow phase definition: ${phase.phase}`,
          path: ["phases"],
        });
      }
      seenPhases.add(phase.phase);
    }

    const seenOrder = new Set<string>();
    for (const phase of definition.phaseOrder) {
      if (seenOrder.has(phase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate workflow phase order entry: ${phase}`,
          path: ["phaseOrder"],
        });
      }
      seenOrder.add(phase);
      if (!seenPhases.has(phase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Workflow phaseOrder references unknown phase: ${phase}`,
          path: ["phaseOrder"],
        });
      }
    }

    for (const phase of seenPhases) {
      if (!seenOrder.has(phase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Workflow phase definition is missing from phaseOrder: ${phase}`,
          path: ["phases"],
        });
      }
    }
  });

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
