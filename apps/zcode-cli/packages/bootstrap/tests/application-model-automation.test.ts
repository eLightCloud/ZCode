import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { AiSdkModelExecution } from "@zcode/adapters/model";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import { createSessionId } from "@zcode/contracts";
import { ApiKeyAccessConfig, ProviderApiConfig, ProviderConfig } from "@zcode/provider";
import { createTestAgentRuntime, createTestModelFactory } from "./helpers/test-agent-runtime.js";

it("blocks a real Agent child selecting a system model in Automation, and allows a later human turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "application-automation-"));
  try {
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "synthetic",
            object: "chat.completion",
            created: 1,
            model: "synthetic-system",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "child done" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const baseURL = "http://127.0.0.1:9/v1";
    const execution = new AiSdkModelExecution(
      {
        env: {
          ZCODE_APPLICATION_MODEL_TOKEN: "synthetic-private-application-credential",
          ZCODE_APPLICATION_MODEL_BASE_URL: baseURL,
        },
      },
      { transport: transport as typeof fetch },
    );
    const bound = execution.bindModel({
      providerId: "application:synthetic",
      modelId: "synthetic-system",
      providerConfig: new ProviderConfig({
        group: "application-managed",
        access: new ApiKeyAccessConfig({ apiKey: "application-managed" }),
        api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: baseURL }),
      }),
      supportsJsonSchemaOutput: false,
      optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
    });
    let issueWorker = true;
    const workerPurposes: unknown[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("application-automation"),
      {
        workingDirectory: directory,
        mode: "yolo",
        modelStreaming: "off",
        modelSelection: { providerId: "personal:synthetic", modelId: "personal" },
        titleGeneration: { enabled: false },
        compact: { enabled: false },
        memory: { enabled: false },
        subagents: { outputRootDir: directory },
      },
      {
        eventStore: createInMemorySessionEventStore(),
        loadAgentDefinitions: async () => ({
          activeAgents: [
            {
              name: "worker",
              source: "user",
              description: "Synthetic worker",
              systemPrompt: "Synthetic",
              tools: [],
              modelSelection: {
                providerId: "application:synthetic",
                modelId: "synthetic-system",
                options: { reasoningLevel: "low" },
              },
            },
          ],
        }),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            if (observation.factoryInput.selection.providerId === "application:synthetic") {
              workerPurposes.push(observation.invocationContext?.modelRequestPurpose);
              const result = await generateText({
                model: bound.resolveRequest({
                  options: { reasoningLevel: "disabled", maxOutputTokens: 16 },
                }).model,
                prompt: "synthetic",
                maxRetries: 0,
              });
              return {
                text: result.text,
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (issueWorker) {
              issueWorker = false;
              return {
                text: "",
                finishReason: "tool-calls",
                toolCalls: [
                  {
                    id: "synthetic-agent-call",
                    name: "Agent",
                    input: {
                      subagent_type: "worker",
                      description: "Synthetic",
                      prompt: "Synthetic",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              text: "done",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    await runtime.executeTurn("saved rule", undefined, { automationId: "automation-synthetic" });
    expect(workerPurposes).toEqual(["automation"]);
    expect(transport).not.toHaveBeenCalled();
    issueWorker = true;
    await runtime.executeTurn("human follow-up");
    expect(workerPurposes).toEqual(["automation", undefined]);
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
