import type { Logger, ModelStatusSink } from "@zcode/contracts";
import type { AiSdkModelTextRequest } from "./runner-runtime.js";

import type { EnvRecord } from "./model-execution.js";

import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

import type { AiSdkModelRuntime, ResolvedAiSdkModel } from "./runner-runtime.js";

export type RunGenerateTextInput = {
  debugDir?: string;
  env: EnvRecord;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolveModel: () => ResolvedAiSdkModel;
  resolved: ResolvedAiSdkModel;
  retry: ResolvedAiSdkModelRetryOptions;
  runtime: AiSdkModelRuntime;
  statusSink?: ModelStatusSink;
  modelIoFullRetentionEnabled: boolean;
};
