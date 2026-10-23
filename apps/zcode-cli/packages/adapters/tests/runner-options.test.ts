import { createTestModelProperties } from "./test-model-format.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelErrorCode } from "@zcode/contracts";
import { createModel } from "../src/model/model.js";
import { compileModelOptionMaps, RestrictedCelError } from "@zcode/model-option-map";
import { createModelOptionMapFetch } from "../src/model/model-option-map-fetch.js";
import {
  createGenerateTextOptions,
  createStreamTextOptions,
  shouldIncludeStreamResponseBody,
} from "../src/model/runner-options.js";
import { isOpenCodeGoBaseUrl } from "../src/model/opencode-session.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";

function resolved(partial: Partial<ResolvedAiSdkModel>): ResolvedAiSdkModel {
  // fixture 以 Registry 已解析的 ModelProperties 和平铺身份构造执行句柄。
  return { properties: createTestModelProperties(), ...partial } as ResolvedAiSdkModel;
}

// 当前公共 Model 验证显式预算；per-option map 在最终 JSON 出口落实协议字段。
// 这里复用生产 Model/Fetch，绝不在测试夹具恢复旧预算或 Provider-name 推断算法。
async function executeBudget(
  maxOutputTokens: number | undefined,
  map: string,
  body: Record<string, any> = {},
) {
  let wire: unknown;
  const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    wire = JSON.parse(String(init?.body));
    return new Response("{}");
  });
  const generateText = vi.fn(
    async (request: import("../src/model/model.js").ModelExecutionRequest) => {
      const fetch = createModelOptionMapFetch({
        fetch: transport,
        maps: compileModelOptionMaps({
          reasoningLevel: { map: "{}" },
          maxOutputTokens: { map },
        }),
        values: request.options,
      });
      await fetch("https://model.example.test", { method: "POST", body: JSON.stringify(body) });
      return {
        text: "ok",
        finishReason: "stop" as const,
        usage: {},
        providerId: "provider",
        modelId: "model",
      };
    },
  );
  const model = createModel({
    providerId: "provider",
    modelId: "model",
    properties: createTestModelProperties(),
    optionSpecs: {
      maxOutputTokens: { type: "limit", max: 200_000, map },
      reasoningLevel: { type: "enum", values: ["low"], map: "{}" },
    },
    executor: {
      generateText,
      async *streamText() {
        throw new Error("unexpected stream executor");
      },
    },
    options: { reasoningLevel: "low" },
  });
  const request = {
    messages: [{ role: "user" as const, content: "hello" }],
    options: { maxOutputTokens },
  };
  if (
    maxOutputTokens === undefined ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens <= 0 ||
    maxOutputTokens > 200_000
  ) {
    await expect(model.generateText(request)).rejects.toMatchObject({
      code: ModelErrorCode.InvalidModelRequest,
    });
    expect(() => model.streamText(request)).toThrow("maxOutputTokens is outside");
    expect(generateText).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    return;
  }
  await model.generateText(request);
  expect(generateText).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(model.options).toEqual({ reasoningLevel: "low" });
  return wire;
}

describe("shouldIncludeStreamResponseBody", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("enables responseBody capture for zcode-plan openai-compatible providers", () => {
    expect(
      shouldIncludeStreamResponseBody(
        resolved({
          providerKind: "openai-compatible",
          accountAccess: { mode: "start-plan" } as ResolvedAiSdkModel["accountAccess"],
          baseURL: "https://zcode.z.ai/api/v1/zcode-plan",
        }),
      ),
    ).toBe(true);
  });

  it("skips responseBody capture for unrelated providers", () => {
    expect(
      shouldIncludeStreamResponseBody(
        resolved({
          providerKind: "openai-compatible",
          baseURL: "https://api.openai.com/v1",
        }),
      ),
    ).toBe(false);
  });
});

describe("isOpenCodeGoBaseUrl", () => {
  it.each(["https://opencode.ai/zen/go/v1", "https://api.opencode.ai/zen/go/v1/"])(
    "matches OpenCode Go host and path boundaries: %s",
    (baseURL) => {
      expect(isOpenCodeGoBaseUrl(baseURL)).toBe(true);
    },
  );

  it.each([
    "https://opencode.ai/zen/v1",
    "https://opencode.ai/zen/go/v2",
    "https://opencode.ai.example/zen/go/v1",
    "not a url",
    undefined,
  ])("rejects unrelated OpenCode endpoints: %s", (baseURL) => {
    expect(isOpenCodeGoBaseUrl(baseURL)).toBe(false);
  });
});

describe("createStreamTextOptions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps a JSON response schema only into generateText structured output", async () => {
    const responseJsonSchema = {
      additionalProperties: false,
      properties: {
        selected_memories: {
          items: { type: "string" },
          type: "array",
        },
      },
      required: ["selected_memories"],
      type: "object",
    };
    const input = {
      includeModelIO: false,
      request: {
        messages: [{ role: "user" as const, content: "select" }],
        responseJsonSchema,
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test-provider",
        modelId: "test-model",
        providerKind: "custom",
      }),
      statusContext: {
        model: { providerId: "test-provider", modelId: "test-model" },
        providerKind: "custom",
        requestId: "req_structured_output",
        sessionId: "sess_structured_output",
        traceId: "trace_structured_output",
      } as never,
    };

    const generateOptions = createGenerateTextOptions(input);
    const streamOptions = createStreamTextOptions(input);

    expect(generateOptions.output).toBeDefined();
    await expect(generateOptions.output?.responseFormat).resolves.toEqual({
      schema: responseJsonSchema,
      type: "json",
    });
    expect(streamOptions).not.toHaveProperty("output");
  });

  it("keeps explicit generateText schemas on the native Anthropic output format", () => {
    const responseJsonSchema = {
      additionalProperties: false,
      properties: {
        selected_memories: { items: { type: "string" }, type: "array" },
      },
      required: ["selected_memories"],
      type: "object",
    };
    const input = {
      includeModelIO: false,
      request: {
        messages: [{ role: "user" as const, content: "select" }],
        responseJsonSchema,
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test-provider",
        modelId: "lite-model",
        providerKind: "anthropic",
      }),
      statusContext: {
        model: { providerId: "test-provider", modelId: "lite-model" },
        providerKind: "anthropic",
        requestId: "req_native_structured_output",
        sessionId: "sess_native_structured_output",
        traceId: "trace_native_structured_output",
      } as never,
    };
    const generateInput = {
      ...input,
      request: {
        ...input.request,
        maxOutputTokens: 256,
        providerOptions: { anthropic: {} },
      },
      resolved: {
        ...input.resolved,
        providerOptions: {
          anthropic: {
            effort: "medium",
            thinking: { budgetTokens: 8_000, type: "enabled" },
          },
        },
      },
    };

    const generateOptions = createGenerateTextOptions(generateInput);
    // 总预算在 Model/Option Map 边界处理，SDK options 不推导第二份预算。
    expect(generateOptions).not.toHaveProperty("maxOutputTokens");
    expect(generateOptions.providerOptions).toEqual({
      anthropic: { structuredOutputMode: "outputFormat" },
    });
    expect(createStreamTextOptions(input).providerOptions).toBeUndefined();
  });

  it("applies the same empty-user wire fallback to generate and stream requests", () => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        includeModelIO: false,
        request: {
          messages: [{ role: "user", content: "" }],
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          providerId: "custom-compatible",
          modelId: "empty-user-model",
          providerKind: "openai-compatible",
          baseURL: "https://api.example.test/v1",
        }),
        statusContext: {
          model: { providerId: "custom-compatible", modelId: "empty-user-model" },
          providerKind: "openai-compatible",
          requestId: "req_empty_user",
          sessionId: "sess_empty_user",
          traceId: "trace_empty_user",
        } as never,
      });

      expect(options.messages).toEqual([{ role: "user", content: "(no content)" }]);
    }
  });

  it("passes resolved image support into generateText message transforms", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                mediaType: "image/png",
                dataUrl: "data:image/png;base64,aW1hZ2U=",
              },
            ],
          },
        ],
      },
      resolved: resolved({
        properties: createTestModelProperties({ supportsImage: false }),
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "zai",
        modelId: "glm-text",
        providerKind: "openai-compatible",
      }),
      statusContext: {
        model: { providerId: "zai", modelId: "glm-text" },
        providerKind: "openai-compatible",
        requestId: "req_text_only",
        sessionId: "sess_text_only",
        traceId: "trace_text_only",
      } as never,
    });

    expect((options.messages[0] as any).content).toEqual([
      {
        type: "text",
        text: "[Attached image/png]\n[Media omitted from provider request because the selected model does not support image input.]",
      },
    ]);
  });

  it("strips video before the OpenAI Responses adapter sees an unsupported file part", () => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        includeModelIO: false,
        request: {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "video",
                  mediaType: "video/mp4",
                  dataUrl: "data:video/mp4;base64,dmlkZW8=",
                },
              ],
            },
          ],
        },
        resolved: resolved({
          properties: createTestModelProperties({ supportsVideo: false }),
          model: {} as ResolvedAiSdkModel["model"],
          providerId: "openai",
          modelId: "gpt-test",
          providerKind: "openai",
        }),
        statusContext: {
          model: { providerId: "openai", modelId: "gpt-test" },
          providerKind: "openai",
          requestId: "req_openai_video",
          sessionId: "sess_openai_video",
          traceId: "trace_openai_video",
        } as never,
      });

      expect((options.messages[0] as any).content).toEqual([
        {
          type: "text",
          text: "[Attached video/mp4]\n[Media omitted from provider request because the selected model does not support video input.]",
        },
      ]);
    }
  });

  it("maps the total Anthropic generate budget without subtracting a second budget", async () => {
    const body = { thinking: { type: "enabled", budget_tokens: 1_024 } };
    expect(await executeBudget(131_072, "{'max_tokens': maxOutputTokens}", body)).toEqual({
      ...body,
      max_tokens: 131_072,
    });
  });

  it("maps the total Anthropic stream budget without guessing thinking overhead", async () => {
    expect(
      await executeBudget(131_072, "{'max_tokens': maxOutputTokens}", { stream: true }),
    ).toEqual({ stream: true, max_tokens: 131_072 });
  });

  it("does not mutate fixed thinking fields while mapping the explicit total budget", async () => {
    const body = {
      thinking: { type: "enabled", budget_tokens: 32_000 },
      effort: "high",
      vendorFlag: "kept",
    };
    const before = structuredClone(body);
    expect(await executeBudget(20_000, "{'max_tokens': maxOutputTokens}", body)).toEqual({
      ...body,
      max_tokens: 20_000,
    });
    expect(body).toEqual(before);
  });

  it.each([0.5, 1])(
    "validates the total budget without inferring a thinking minimum: %s",
    async (maxOutputTokens) => {
      const wire = await executeBudget(maxOutputTokens, "{'max_tokens': maxOutputTokens}");
      if (maxOutputTokens === 1) expect(wire).toEqual({ max_tokens: 1 });
    },
  );

  it("maps explicit OpenAI-compatible total tokens at the raw-body boundary", async () => {
    expect(await executeBudget(131_072, "{'max_tokens': maxOutputTokens}")).toEqual({
      max_tokens: 131_072,
    });
  });

  it.each([
    { caseId: "OTB01", modelLimit: undefined },
    { caseId: "OTB02", modelLimit: 16_000 },
    { caseId: "OTB03", modelLimit: 64_000 },
    { caseId: "fractional normalization", modelLimit: 16_000.9 },
    { caseId: "invalid zero", modelLimit: 0 },
    { caseId: "invalid negative", modelLimit: -1 },
    { caseId: "invalid non-finite", modelLimit: Number.NaN },
  ])(
    "$caseId validates explicit model budget $modelLimit without fallback or rounding",
    async ({ modelLimit }) => {
      const wire = await executeBudget(modelLimit, "{'max_tokens': maxOutputTokens}");
      if (Number.isInteger(modelLimit) && modelLimit > 0)
        expect(wire).toEqual({ max_tokens: modelLimit });
    },
  );

  it.each([
    {
      name: "model-capability source",
      providerKind: "openai-compatible" as const,
      source: "model-capability" as const,
    },
    {
      name: "runtime-default source",
      providerKind: "openai-compatible" as const,
      source: "runtime-default" as const,
    },
    {
      name: "legacy Anthropic request",
      providerKind: "anthropic" as const,
      source: undefined,
    },
    {
      name: "legacy non-Anthropic request",
      providerKind: "openai-compatible" as const,
      source: undefined,
    },
  ])("rejects a missing explicit budget before I/O for $name", async () => {
    await executeBudget(undefined, "{'max_tokens': maxOutputTokens}");
  });

  it.each(["openai", "openai-compatible", "gateway", "custom"] as const)(
    "uses an explicit option map instead of inferring budget from %s kind",
    async (providerKind) => {
      const map =
        providerKind === "openai"
          ? "{'max_completion_tokens': maxOutputTokens}"
          : "{'max_tokens': maxOutputTokens}";
      expect(await executeBudget(131_072, map)).toEqual(
        providerKind === "openai" ? { max_completion_tokens: 131_072 } : { max_tokens: 131_072 },
      );
    },
  );

  it("maps an explicitly selected Compact budget for OpenAI-compatible transport", async () => {
    expect(await executeBudget(20_000, "{'max_tokens': maxOutputTokens}")).toEqual({
      max_tokens: 20_000,
    });
  });

  it("lets the declared option map override SDK output fields while retaining vendor fields", async () => {
    const body = { max_tokens: 32_768, vendor_flag: true };
    expect(await executeBudget(64_000, "{'max_tokens': maxOutputTokens}", body)).toEqual({
      max_tokens: 64_000,
      vendor_flag: true,
    });
    expect(body).toEqual({ max_tokens: 32_768, vendor_flag: true });
  });

  it("rejects missing Model budget even if a raw provider body contains max_tokens", async () => {
    await executeBudget(undefined, "{'max_tokens': maxOutputTokens}", { max_tokens: 32_768 });
  });

  it("maps explicitly bound Anthropic total output tokens", async () => {
    expect(await executeBudget(131_072, "{'max_tokens': maxOutputTokens}")).toEqual({
      max_tokens: 131_072,
    });
  });

  it("maps the explicit Compact summary budget on Anthropic transport", async () => {
    expect(
      await executeBudget(20_000, "{'max_tokens': maxOutputTokens}", {
        thinking: { type: "disabled" },
      }),
    ).toEqual({ max_tokens: 20_000, thinking: { type: "disabled" } });
  });

  it("passes static provider namespaces without guessing a provider-name projection", () => {
    const options = createStreamTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
        providerOptions: {
          openaiCompatible: {
            extra_body: {
              chat_template_kwargs: {
                reasoning_effort: "max",
              },
            },
          },
        },
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "custom-glm",
        modelId: "GLM-5.2",
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
        providerOptionsName: "GLM52 E2E",
      } as Partial<ResolvedAiSdkModel> & { providerOptionsName: string }),
      statusContext: {
        model: { providerId: "custom-glm", modelId: "GLM-5.2" },
        providerKind: "openai-compatible",
        requestId: "req_glm52",
        sessionId: "sess_glm52",
        traceId: "trace_glm52",
      } as never,
    });

    expect(options.providerOptions).toEqual({
      openaiCompatible: {
        extra_body: {
          chat_template_kwargs: {
            reasoning_effort: "max",
          },
        },
      },
    });
  });

  it("preserves raw and sibling namespaces without implicit rewriting", () => {
    const options = createStreamTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
        providerOptions: {
          openaiCompatible: {
            extra_body: {
              mode: "legacy",
              thinking: { type: "enabled" },
            },
            mode: "direct",
            reasoningEffort: "max",
          },
          "foo-bar": {
            rawOnly: true,
          },
          fooBar: {
            camelOnly: true,
          },
          "openai-compatible": {
            legacyOnly: true,
          },
          anthropic: {
            siblingOnly: true,
          },
        },
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "foo-bar",
        modelId: "reasoning-model",
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
        providerOptionsName: "foo-bar",
      } as Partial<ResolvedAiSdkModel> & { providerOptionsName: string }),
      statusContext: {
        model: { providerId: "foo-bar", modelId: "reasoning-model" },
        providerKind: "openai-compatible",
        requestId: "req_namespace_pass_through",
        sessionId: "sess_namespace_pass_through",
        traceId: "trace_namespace_pass_through",
      } as never,
    });

    expect(options.providerOptions).toEqual({
      openaiCompatible: {
        extra_body: {
          mode: "legacy",
          thinking: { type: "enabled" },
        },
        mode: "direct",
        reasoningEffort: "max",
      },
      "foo-bar": { rawOnly: true },
      fooBar: {
        camelOnly: true,
      },
      "openai-compatible": {
        legacyOnly: true,
      },
      anthropic: {
        siblingOnly: true,
      },
    });
  });

  it("rejects an option map with a non-object patch before network I/O", () => {
    expect(() =>
      compileModelOptionMaps({ reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "[]" } }),
    ).toThrow(RestrictedCelError);
  });

  it("passes experimental_include.responseBody for zcode-plan streams", () => {
    const options = createStreamTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "builtin:zai-coding-plan",
        modelId: "glm-5.1",
        accountAccess: { mode: "start-plan" } as ResolvedAiSdkModel["accountAccess"],
        providerKind: "openai-compatible",
        baseURL: "https://zcode.z.ai/api/v1/zcode-plan",
      }),
      statusContext: {
        model: { providerId: "builtin:zai-coding-plan", modelId: "glm-5.1" },
        providerKind: "openai-compatible",
        requestId: "req_test",
        sessionId: "sess_test",
        traceId: "trace_test",
      } as never,
    });

    expect(options.experimental_include).toEqual({ responseBody: true });
  });

  it("uses merged Responses provider options while transforming history", () => {
    const toolCallId = "call_read";
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "stored reasoning",
                providerOptions: { openai: { itemId: "rs_1" } },
              },
              { type: "text", text: "checking" },
            ],
            toolCalls: [{ id: toolCallId, name: "Read", input: { file_path: "README.md" } }],
          },
        ],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "openai",
        modelId: "gpt-5",
        providerKind: "openai",
        providerOptions: { apiFormat: "openai-responses" },
      }),
      statusContext: {
        model: { providerId: "openai", modelId: "gpt-5" },
        providerKind: "openai",
        requestId: "req_responses",
        sessionId: "sess_responses",
        traceId: "trace_responses",
      } as never,
    });

    const [message] = options.messages ?? [];
    expect((message as any).content).toEqual([
      { type: "text", text: "checking" },
      {
        type: "tool-call",
        toolCallId,
        toolName: "Read",
        input: { file_path: "README.md" },
      },
    ]);
    expect(options.providerOptions).toEqual({ apiFormat: "openai-responses" });
  });

  it("preserves static OpenAI options without interpreting obsolete top-level aliases", () => {
    for (const createOptions of [createGenerateTextOptions, createStreamTextOptions]) {
      const options = createOptions({
        includeModelIO: false,
        request: {
          messages: [{ role: "user", content: "Generate a title" }],
          providerOptions: { reasoningEffort: "none" },
        },
        resolved: resolved({
          model: {} as ResolvedAiSdkModel["model"],
          providerKind: "openai",
          providerOptions: { openai: { reasoningEffort: "high", store: false } },
          providerId: "openai",
          modelId: "gpt-5.2",
        }),
        statusContext: {
          model: { providerId: "openai", modelId: "gpt-5.2" },
          providerKind: "openai",
          requestId: "req_openai_reasoning",
          sessionId: "sess_openai_reasoning",
          traceId: "trace_openai_reasoning",
        } as never,
      });

      expect(options.providerOptions).toEqual({
        openai: {
          reasoningEffort: "high",
          store: false,
        },
        reasoningEffort: "none",
      });
    }
  });

  it("adds request attribution headers for generateText requests", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test",
        modelId: "model-a",
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "test", modelId: "model-a" },
        modelRequestSessionType: "main",
        providerKind: "openai-compatible",
        requestId: "req_generate",
        queryId: "query_generate",
        sessionId: "sess_generate",
        traceId: "trace_generate",
      } as never,
    });

    expect(options.headers).toEqual({
      "x-query-id": "generate",
      "x-request-id": "req_generate",
      "x-session-id": "generate",
      "x-zcode-session-type": "main",
      "x-zcode-trace-id": "trace_generate",
    });
  });

  it("keeps provider runtime platform headers with request attribution headers", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        headers: {
          "X-Os-Category": "macos",
          "X-Os-Version": "25.0.0",
          "X-Platform": "darwin-arm64",
          "x-zcode-session-type": "spoofed",
        },
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test",
        modelId: "model-a",
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "test", modelId: "model-a" },
        modelRequestSessionType: "subagent",
        providerKind: "openai-compatible",
        requestId: "req_platform",
        sessionId: "sess_platform",
        traceId: "trace_platform",
      } as never,
    });

    expect(options.headers).toEqual({
      "X-Os-Category": "macos",
      "X-Os-Version": "25.0.0",
      "X-Platform": "darwin-arm64",
      "x-request-id": "req_platform",
      "x-session-id": "platform",
      "x-zcode-session-type": "subagent",
      "x-zcode-trace-id": "trace_platform",
    });
  });

  it("strips internal subagent and query prefixes from request attribution headers", () => {
    const queryId = "query_ad8740cd-f843-4235-ba0d-395063e56fda";
    const sessionId = "sess_subagent_agent_b3d813c3-c568-42e9-8f67-eeb814bc8ef2";
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test",
        modelId: "model-a",
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "test", modelId: "model-a" },
        modelRequestSessionType: "subagent",
        providerKind: "openai-compatible",
        requestId: "req_subagent",
        queryId,
        sessionId,
        traceId: "trace_subagent",
      } as never,
    });

    expect(options.headers).toMatchObject({
      "x-query-id": "ad8740cd-f843-4235-ba0d-395063e56fda",
      "x-session-id": "b3d813c3-c568-42e9-8f67-eeb814bc8ef2",
    });
  });

  it("adds request attribution headers for streamText requests", () => {
    const options = createStreamTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
      },
      resolved: resolved({
        model: {} as ResolvedAiSdkModel["model"],
        providerId: "test",
        modelId: "model-a",
        providerKind: "openai-compatible",
        baseURL: "https://api.example.test/v1",
      }),
      statusContext: {
        model: { providerId: "test", modelId: "model-a" },
        modelRequestSessionType: "other",
        providerKind: "openai-compatible",
        requestId: "req_stream",
        queryId: "query_stream",
        sessionId: "sess_stream",
        traceId: "trace_stream",
      } as never,
    });

    expect(options.headers).toEqual({
      "x-query-id": "stream",
      "x-request-id": "req_stream",
      "x-session-id": "stream",
      "x-zcode-session-type": "other",
      "x-zcode-trace-id": "trace_stream",
    });
  });

  it.each([createGenerateTextOptions, createStreamTextOptions])(
    "adds a stable OpenCode Go session header to %s requests",
    (createOptions) => {
      const options = createOptions({
        includeModelIO: false,
        request: {
          messages: [{ role: "user", content: "hi" }],
        },
        resolved: resolved({
          baseURL: "https://opencode.ai/zen/go/v1",
          headers: { "x-opencode-session": "spoofed" },
          model: {} as ResolvedAiSdkModel["model"],
          providerKind: "openai-compatible",
          providerId: "custom-provider",
          modelId: "kimi-k2.5",
        }),
        statusContext: {
          model: { providerId: "custom-provider", modelId: "kimi-k2.5" },
          modelRequestSessionType: "main",
          providerKind: "openai-compatible",
          requestId: "req_opencode_go",
          sessionId: "sess_conversation_stable",
          traceId: "trace_opencode_go",
          baseURL: "https://opencode.ai/zen/go/v1",
        } as never,
      });

      expect(options.headers).toMatchObject({
        "x-opencode-session": "conversation_stable",
      });
    },
  );

  it("does not add OpenCode Go session header for other providers on the same host", () => {
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: { messages: [{ role: "user", content: "hi" }] },
      resolved: resolved({
        baseURL: "https://opencode.ai/zen/v1",
        model: {} as ResolvedAiSdkModel["model"],
        providerKind: "openai-compatible",
        providerId: "custom-provider",
        modelId: "kimi-k2.5",
      }),
      statusContext: {
        model: { providerId: "custom-provider", modelId: "kimi-k2.5" },
        modelRequestSessionType: "main",
        providerKind: "openai-compatible",
        requestId: "req_opencode_zen",
        sessionId: "sess_conversation_stable",
        traceId: "trace_opencode_zen",
      } as never,
    });

    expect(options.headers).not.toHaveProperty("x-opencode-session");
  });
});
