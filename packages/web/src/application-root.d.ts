declare module "virtual:zcode-application-root" {
  export function prepareApplication(options: {render: (content: import("react").ReactNode) => void}): Promise<void>;
  export const ApplicationShell: import("react").ComponentType<{ children?: import("react").ReactNode }>;
  export const ApplicationRoot: typeof import("@zcode/ui").Root;
}
