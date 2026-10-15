import { z } from "zod";
import {
  parseZCodeBuiltinModelConfigRules,
  parseZCodeBuiltinProviderConfigRules,
  type ModelConfigRules,
  type ProviderConfigMap,
  type ProviderTemplateMap,
} from "@zcode/provider";

export const ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION = 1 as const;
const RETIRED_ZAPI_PROVIDER_ID = "builtin:zapi";

export interface ZCodeBuiltinConfigContent {
  readonly providers: ProviderConfigMap;
  readonly providerTemplates: ProviderTemplateMap;
  readonly modelConfigRules: ModelConfigRules;
}

export interface ZCodeBuiltinRelease {
  readonly applicationDefault?: {
    readonly providerId: string;
    readonly modelId: string;
    readonly options: { readonly reasoningLevel: string };
  };
  readonly schemaVersion: typeof ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION;
  readonly revision: number;
  readonly config: ZCodeBuiltinConfigContent;
}

const releaseSchema = z
  .object({
    applicationDefault: z
      .object({
        providerId: z.string().min(1),
        modelId: z.string().min(1),
        options: z.object({ reasoningLevel: z.string().min(1) }).strict(),
      })
      .strict()
      .optional(),
    schemaVersion: z.literal(ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    config: z
      .object({
        providerConfigRules: z.unknown(),
        modelConfigRules: z.unknown(),
      })
      .strict(),
  })
  .strict();

export function decodeZCodeBuiltinRelease(input: unknown): ZCodeBuiltinRelease {
  const parsed = releaseSchema.parse(input);
  const { providers, providerTemplates } = parseZCodeBuiltinProviderConfigRules(
    parsed.config.providerConfigRules,
  );
  // ZAPI 已退出产品，旧 Remote Release 或 LKG 不能在 Renderer 静态入口删除后
  // 又通过目标 Host Registry 将它重新发布。拒绝整份不兼容 Release，让 Source 回落到兼容候选。
  if (providers.has(RETIRED_ZAPI_PROVIDER_ID)) {
    throw new Error(`ZCode Built-in Release 包含已退出的 Provider: ${RETIRED_ZAPI_PROVIDER_ID}`);
  }
  return Object.freeze({
    schemaVersion: ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: parsed.revision,
    ...(parsed.applicationDefault ? { applicationDefault: parsed.applicationDefault } : {}),
    config: Object.freeze({
      providers,
      providerTemplates,
      modelConfigRules: parseZCodeBuiltinModelConfigRules(parsed.config.modelConfigRules),
    }),
  });
}

export function encodeZCodeBuiltinRelease(release: ZCodeBuiltinRelease): object {
  return {
    schemaVersion: ZCODE_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: release.revision,
    ...(release.applicationDefault ? { applicationDefault: release.applicationDefault } : {}),
    config: {
      providerConfigRules: {
        templateRules: release.config.providerTemplates.toJSON(),
        providerRules: release.config.providers.toJSON(),
      },
      modelConfigRules: release.config.modelConfigRules.toZCodeBuiltinJSON(),
    },
  };
}

export function serializeZCodeBuiltinRelease(release: ZCodeBuiltinRelease): string {
  return JSON.stringify(encodeZCodeBuiltinRelease(release));
}
