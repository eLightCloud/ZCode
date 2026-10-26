declare module "virtual:zcode-application-root" {
  export function prepareApplication(options: {
    render: (content: import("react").ReactNode) => void;
    route: "server" | "native-cloud";
    renderWorkspace?: (
      entry: NonNullable<
        import("react").ComponentProps<typeof import("@zcode/ui").Root>["workspaceEntry"]
      >,
    ) => import("react").ReactNode;
  }): Promise<
    | void
    | false
    | {
        initialTaskDraft?: import("react").ComponentProps<
          typeof import("@zcode/ui").Root
        >["initialTaskDraft"];
      }
  >;
  export const ApplicationShell: import("react").ComponentType<{
    children?: import("react").ReactNode;
  }>;
  export const ApplicationRoot: typeof import("@zcode/ui").Root;
}
