export type JsonSchema = Record<string, unknown>;

export type ModelProviderId = string & { readonly __brand: "ModelProviderId" };

export type ModelId = string & { readonly __brand: "ModelId" };
