/** Existing component metadata; behavior remains at the original public entries. */
export const moduleDefinition = {
  id: "workflow-run-presentation",
  requires: ["ui", "shared"],
  provides: ["workflow-run-presentation"],
  publicEntrypoints: [
    "packages/ui/src/workflow-run-presentation/index.ts",
    "packages/ui/src/workflow-run-presentation/contract.ts",
    "packages/ui/src/lib/workflowRunLine.ts",
  ],
} as const;
