import { describe, expect, test, afterEach } from "bun:test";
import { PostTaskReflector, shouldReflect } from "@pegasus/agents/cognitive/reflect.ts";
import type { ReflectionDeps } from "@pegasus/agents/cognitive/reflect.ts";
import { createReflectionContext } from "@pegasus/agents/cognitive/reflect.ts";
import type { LanguageModel, GenerateTextResult } from "@pegasus/infra/llm-types.ts";
import type { Persona } from "@pegasus/identity/persona.ts";
import { ToolRegistry } from "@pegasus/tools/registry.ts";
import { ToolExecutor } from "@pegasus/tools/executor.ts";
import { EventBus } from "@pegasus/events/bus.ts";
import { reflectionTools } from "@pegasus/tools/builtins/index.ts";
import { rm, mkdir } from "node:fs/promises";

const testDataDir = "/tmp/pegasus-test-post-reflector";
const testMemoryDir = `${testDataDir}/memory`;

const testPersona: Persona = {
  name: "TestBot",
  role: "test assistant",
  personality: ["helpful"],
  style: "concise",
  values: ["accuracy"],
};

function createReflectionDeps(model: LanguageModel): ReflectionDeps {
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerMany(reflectionTools);
  const bus = new EventBus();
  const toolExecutor = new ToolExecutor(toolRegistry, bus, 5000);
  return {
    model,
    persona: testPersona,
    toolRegistry,
    toolExecutor,
    memoryDir: testMemoryDir,
    contextWindowSize: 128_000,
  };
}

describe("shouldReflect", () => {
  test("returns false for trivial single-iteration task with short response", () => {
    const ctx = createReflectionContext({ inputText: "what time?" });
    ctx.iteration = 1;
    ctx.actionsDone = [
      { stepIndex: 0, actionType: "respond", actionInput: {}, success: true, startedAt: Date.now() },
    ];
    ctx.finalResult = { response: "It's 3pm" };
    expect(shouldReflect(ctx)).toBe(false);
  });

  test("returns true for multi-iteration task", () => {
    const ctx = createReflectionContext({ inputText: "search" });
    ctx.iteration = 2;
    ctx.actionsDone = [
      { stepIndex: 0, actionType: "tool_call", actionInput: {}, success: true, startedAt: Date.now() },
      { stepIndex: 1, actionType: "respond", actionInput: {}, success: true, startedAt: Date.now() },
    ];
    ctx.finalResult = { response: "Found it" };
    expect(shouldReflect(ctx)).toBe(true);
  });

  test("returns false for zero tool calls with single iteration", () => {
    const ctx = createReflectionContext({ inputText: "hello" });
    ctx.iteration = 1;
    ctx.actionsDone = [];
    ctx.finalResult = { response: "Hi there!" };
    expect(shouldReflect(ctx)).toBe(false);
  });

  test("returns false for single-iteration task with result under 500 chars", () => {
    const ctx = createReflectionContext({ inputText: "what time?" });
    ctx.iteration = 1;
    ctx.actionsDone = [
      { stepIndex: 0, actionType: "respond", actionInput: {}, success: true, startedAt: Date.now() },
    ];
    ctx.finalResult = { response: "A".repeat(300) };
    expect(shouldReflect(ctx)).toBe(false);
  });

  test("returns true for single-iteration task with result over 500 chars", () => {
    const ctx = createReflectionContext({ inputText: "explain" });
    ctx.iteration = 1;
    ctx.actionsDone = [
      { stepIndex: 0, actionType: "respond", actionInput: {}, success: true, startedAt: Date.now() },
    ];
    ctx.finalResult = { response: "A".repeat(600) };
    expect(shouldReflect(ctx)).toBe(true);
  });

  test("returns true when multiple actions done", () => {
    const ctx = createReflectionContext({ inputText: "complex" });
    ctx.iteration = 1;
    ctx.actionsDone = [
      { stepIndex: 0, actionType: "tool_call", actionInput: {}, success: true, startedAt: Date.now() },
      { stepIndex: 1, actionType: "tool_call", actionInput: {}, success: true, startedAt: Date.now() },
    ];
    ctx.finalResult = { response: "done" };
    expect(shouldReflect(ctx)).toBe(true);
  });
});

describe("PostTaskReflector", () => {
  afterEach(async () => {
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  test("LLM calls no tools — returns assessment only", async () => {
    await mkdir(testMemoryDir, { recursive: true });

    const model: LanguageModel = {
      provider: "test", modelId: "test",
      async generate(): Promise<GenerateTextResult> {
        return {
          text: "Nothing worth recording.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const reflector = new PostTaskReflector(createReflectionDeps(model));
    const ctx = createReflectionContext({ inputText: "simple task" });
    ctx.iteration = 2;
    ctx.finalResult = { response: "Done" };

    const result = await reflector.run(ctx, [], []);

    expect(result.assessment).toBe("Nothing worth recording.");
    expect(result.toolCallsCount).toBe(0);
  });

  test("LLM calls memory_write then completes", async () => {
    await mkdir(testMemoryDir, { recursive: true });

    let callCount = 0;
    const model: LanguageModel = {
      provider: "test", modelId: "test",
      async generate(): Promise<GenerateTextResult> {
        callCount++;
        if (callCount === 1) {
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [{
              id: "tc1",
              name: "memory_write",
              arguments: {
                path: "facts/memory.md",
                content: "# Learned\n> Summary: test\n\n- Something new",
              },
            }],
            usage: { promptTokens: 10, completionTokens: 10 },
          };
        }
        return {
          text: "Recorded a new fact.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const reflector = new PostTaskReflector(createReflectionDeps(model));
    const ctx = createReflectionContext({ inputText: "learned something" });
    ctx.iteration = 2;
    ctx.finalResult = { response: "Done" };

    const result = await reflector.run(ctx, [], []);

    expect(result.assessment).toBe("Recorded a new fact.");
    expect(result.toolCallsCount).toBe(1);

    // Verify file was actually written
    const content = await Bun.file(`${testMemoryDir}/facts/memory.md`).text();
    expect(content).toContain("Something new");
  });

  test("LLM error propagates (caught by Agent)", async () => {
    await mkdir(testMemoryDir, { recursive: true });

    const model: LanguageModel = {
      provider: "test", modelId: "test",
      async generate() { throw new Error("LLM API error"); },
    };

    const reflector = new PostTaskReflector(createReflectionDeps(model));
    const ctx = createReflectionContext({ inputText: "task" });
    ctx.iteration = 2;
    ctx.finalResult = { response: "Done" };

    await expect(reflector.run(ctx, [], [])).rejects.toThrow("LLM API error");
  });

  test("receives existing facts and episodes in system prompt", async () => {
    await mkdir(testMemoryDir, { recursive: true });

    let capturedSystem = "";
    const model: LanguageModel = {
      provider: "test", modelId: "test",
      async generate(options: { system?: string }): Promise<GenerateTextResult> {
        capturedSystem = options.system ?? "";
        return {
          text: "Reviewed.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const reflector = new PostTaskReflector(createReflectionDeps(model));
    const ctx = createReflectionContext({ inputText: "task" });
    ctx.iteration = 2;
    ctx.finalResult = { response: "Done" };

    await reflector.run(
      ctx,
      [{ path: "facts/user.md", content: "# User\n- Name: jianjun" }],
      [{ path: "episodes/2026-02.md", summary: "logger fix, config" }],
    );

    expect(capturedSystem).toContain("facts/user.md");
    expect(capturedSystem).toContain("Name: jianjun");
    expect(capturedSystem).toContain("episodes/2026-02.md");
    expect(capturedSystem).toContain("logger fix, config");
  });

  test("includes conversation history in messages", async () => {
    await mkdir(testMemoryDir, { recursive: true });

    let capturedMessages: Array<{ role: string; content: string }> = [];
    const model: LanguageModel = {
      provider: "test", modelId: "test",
      async generate(options: {
        messages?: Array<{ role: string; content: string }>;
      }): Promise<GenerateTextResult> {
        capturedMessages = options.messages ?? [];
        return {
          text: "Reviewed.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const reflector = new PostTaskReflector(createReflectionDeps(model));
    const ctx = createReflectionContext({ inputText: "search for papers" });
    ctx.iteration = 2;
    ctx.messages = [
      { role: "user", content: "search for papers" },
      { role: "assistant", content: "Found 3 papers on AI agents." },
    ];
    ctx.finalResult = { response: "Found 3 papers." };

    await reflector.run(ctx, [], []);

    expect(capturedMessages[0]!.content).toContain("[Task completed]");
    expect(capturedMessages[0]!.content).toContain("search for papers");
    expect(capturedMessages[1]!.content).toBe("search for papers");
    expect(capturedMessages[2]!.content).toBe("Found 3 papers on AI agents.");
  });

  test("system prompt includes persona identity", async () => {
    await mkdir(testMemoryDir, { recursive: true });

    let capturedSystem = "";
    const model: LanguageModel = {
      provider: "test", modelId: "test",
      async generate(options: { system?: string }): Promise<GenerateTextResult> {
        capturedSystem = options.system ?? "";
        return {
          text: "Reviewed.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const reflector = new PostTaskReflector(createReflectionDeps(model));
    const ctx = createReflectionContext({ inputText: "task" });
    ctx.iteration = 2;
    ctx.finalResult = { response: "Done" };

    await reflector.run(ctx, [], []);

    expect(capturedSystem).toContain("TestBot");
    expect(capturedSystem).toContain("test assistant");
  });

  test("system prompt enforces fact file naming (user.md and memory.md only)", async () => {
    await mkdir(testMemoryDir, { recursive: true });

    let capturedSystem = "";
    const model: LanguageModel = {
      provider: "test", modelId: "test",
      async generate(options: { system?: string }): Promise<GenerateTextResult> {
        capturedSystem = options.system ?? "";
        return {
          text: "Reviewed.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const reflector = new PostTaskReflector(createReflectionDeps(model));
    const ctx = createReflectionContext({ inputText: "task" });
    ctx.iteration = 2;
    ctx.finalResult = { response: "Done" };

    await reflector.run(ctx, [], []);

    expect(capturedSystem).toContain("user.md");
    expect(capturedSystem).toContain("memory.md");
    expect(capturedSystem).toContain("Do NOT create");
  });

  test("system prompt includes quality guidelines", async () => {
    await mkdir(testMemoryDir, { recursive: true });

    let capturedSystem = "";
    const model: LanguageModel = {
      provider: "test", modelId: "test",
      async generate(options: { system?: string }): Promise<GenerateTextResult> {
        capturedSystem = options.system ?? "";
        return {
          text: "Reviewed.",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    const reflector = new PostTaskReflector(createReflectionDeps(model));
    const ctx = createReflectionContext({ inputText: "task" });
    ctx.iteration = 2;
    ctx.finalResult = { response: "Done" };

    await reflector.run(ctx, [], []);

    // Worth recording
    expect(capturedSystem).toContain("social relationships");
    expect(capturedSystem).toContain("important dates");
    // NOT worth recording
    expect(capturedSystem).toContain("NOT Worth Recording");
    expect(capturedSystem).toContain("re-retrieved");
  });

  test("max rounds returns graceful result", async () => {
    await mkdir(testMemoryDir, { recursive: true });

    // Model always returns tool calls — never stops
    const model: LanguageModel = {
      provider: "test", modelId: "test",
      async generate(): Promise<GenerateTextResult> {
        return {
          text: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: `tc-${Date.now()}`,
            name: "memory_read",
            arguments: { path: "facts/user.md" },
          }],
          usage: { promptTokens: 10, completionTokens: 10 },
        };
      },
    };

    // Create the file so memory_read succeeds
    await mkdir(`${testMemoryDir}/facts`, { recursive: true });
    await Bun.write(`${testMemoryDir}/facts/user.md`, "# User\n- Name: test");

    const reflector = new PostTaskReflector(createReflectionDeps(model));
    const ctx = createReflectionContext({ inputText: "task" });
    ctx.iteration = 2;
    ctx.finalResult = { response: "Done" };

    const result = await reflector.run(ctx, [], []);

    expect(result.assessment).toContain("Max reflection rounds");
    expect(result.toolCallsCount).toBeGreaterThanOrEqual(5); // 5 rounds × 1 tool call
  }, 10_000);
});
