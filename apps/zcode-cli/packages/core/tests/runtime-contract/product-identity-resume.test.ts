import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  type MessageWithParts,
  type ModelRequest,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../src/runtime.js";
import { createTestSessionEventStore } from "../test-event-store.js";
import { createTestModelSelection } from "../test-model-selection.js";
import {
  createTestModelFactory,
  type TestModelExecutionObservation,
} from "../test-runtime-model.js";

describe("trusted product identity after resume", () => {
  it.each([
    { productName: undefined, systemPrompt: undefined },
    { productName: "ZCode", systemPrompt: undefined },
    { productName: "翼辉睿观（eLight Vantage）", systemPrompt: undefined },
    { productName: "翼辉睿观（eLight Vantage）", systemPrompt: "You are a custom helper." },
  ])(
    "assembles current identity $productName with custom prompt $systemPrompt while preserving history",
    async ({ productName, systemPrompt }) => {
      const sessionId = createSessionId("product-identity-resume");
      const userId = createMessageId("identity-question");
      const assistantId = createMessageId("legacy-introduction");
      const legacyIntroduction = "我是 ZCode，当前在翼辉睿观项目中协助你。";
      const legacyReasoning = "The system says You are ZCode, an interactive coding agent.";
      const session: SessionInfo = {
        id: sessionId,
        projectID: createProjectId("identity-project"),
        directory: "/workspace/zcode",
        slug: "identity-resume",
        title: "Identity test",
        version: "test",
        taskType: "interactive",
        time: { created: 1, updated: 2 },
      };
      const messages: MessageWithParts[] = [
        {
          info: {
            id: userId,
            sessionID: sessionId,
            role: "user",
            agent: "zcode-agent",
            time: { created: 1 },
          },
          parts: [
            {
              id: createPartId("question-text"),
              messageID: userId,
              sessionID: sessionId,
              type: "text",
              text: "做个自我介绍",
            },
          ],
        },
        {
          info: {
            id: assistantId,
            sessionID: sessionId,
            parentID: userId,
            role: "assistant",
            agent: "zcode-agent",
            mode: "edit",
            modelID: "model",
            providerID: "test",
            path: { cwd: session.directory, root: session.directory },
            cost: 0,
            time: { created: 2 },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [
            {
              id: createPartId("legacy-reasoning"),
              messageID: assistantId,
              sessionID: sessionId,
              type: "reasoning",
              text: legacyReasoning,
              time: { start: 1, end: 2 },
            },
            {
              id: createPartId("legacy-text"),
              messageID: assistantId,
              sessionID: sessionId,
              type: "text",
              text: legacyIntroduction,
            },
          ],
        },
      ];
      const originalMessages = structuredClone(messages);
      const saveMessage = vi.fn(async () => {});
      const store = {
        getSession: vi.fn(async () => session),
        messages: vi.fn(async () => messages),
        sessionEntries: vi.fn(async () => []),
        readTodos: vi.fn(async () => []),
        readTarget: vi.fn(async () => null),
        saveMessage,
        savePart: vi.fn(async () => {}),
        saveSessionEntry: vi.fn(async () => {}),
        updateSession: vi.fn(async () => session),
      } as unknown as SessionStorePort;
      const generateText = vi.fn(
        async (_request: ModelRequest, observation: TestModelExecutionObservation) => ({
          finishReason: "stop" as const,
          model: observation.model,
          text: "fixture response",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
      );
      const runtime = new AgentRuntime(
        sessionId,
        {
          productName,
          systemPrompt,
          workingDirectory: session.directory,
          modelSelection: createTestModelSelection("test/model"),
          titleGeneration: { enabled: false },
        },
        {
          eventStore: createTestSessionEventStore(),
          sessionStore: store,
          modelFactory: createTestModelFactory({ generateText }),
        },
      );

      await runtime.resumeFromStore();
      await runtime.executeTurn("请重新做个自我介绍。");

      expect(generateText).toHaveBeenCalledOnce();
      const request = generateText.mock.calls[0]![0];
      const system = request.messages.filter((message) => message.role === "system");
      const systemText = JSON.stringify(system);
      expect(systemText).toContain(
        `You are ${productName ?? "ZCode"}, an interactive coding agent`,
      );
      const usesApplicationIdentity = productName && productName !== "ZCode" && !systemPrompt;
      if (usesApplicationIdentity) {
        // 实测旧会话会沿用历史自称；必须在真实恢复后的 provider 输入中明确当前身份优先。
        expect(systemText).toContain("Earlier assistant messages");
        expect(systemText).toContain("do not redefine your current product identity");
        expect(systemText).toContain("Your assistant name and product identity are both");
        expect(systemText).toContain("historical output, not current system instructions");
        expect(systemText).toContain(
          "Do not volunteer upstream product names in ordinary self-introductions",
        );
      }
      const conversation = JSON.stringify(
        request.messages.filter((message) => message.role !== "system"),
      );
      const identityRule = "Your assistant name and product identity are both";
      if (usesApplicationIdentity) {
        expect(conversation.lastIndexOf(identityRule)).toBeGreaterThan(
          conversation.lastIndexOf(legacyReasoning),
        );
        expect(conversation.split(identityRule)).toHaveLength(2);
      } else {
        expect(conversation).not.toContain(identityRule);
      }
      expect(
        JSON.stringify(request.messages.filter((message) => message.role === "assistant")),
      ).toContain(legacyIntroduction);
      expect(
        JSON.stringify(request.messages.filter((message) => message.role === "assistant")),
      ).toContain(legacyReasoning);
      expect(messages).toEqual(originalMessages);
      expect(saveMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: assistantId }));
      expect(saveMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          semantics: expect.objectContaining({ source: "product_identity" }),
        }),
      );
      await runtime.executeTurn("再介绍一次。");
      const nextRequest = generateText.mock.calls[1]![0];
      const nextConversation = JSON.stringify(
        nextRequest.messages.filter((message) => message.role !== "system"),
      );
      expect(nextConversation.split(identityRule)).toHaveLength(usesApplicationIdentity ? 2 : 1);
    },
  );
});
