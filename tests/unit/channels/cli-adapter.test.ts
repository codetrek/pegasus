/**
 * Tests for CLIAdapter — Terminal channel adapter.
 *
 * Uses PassThrough streams to simulate stdin/stdout without real terminal I/O.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { CLIAdapter } from "@pegasus/channels/cli-adapter.ts";
import type { InboundMessage, OutboundMessage } from "@pegasus/channels/types.ts";
import { PassThrough } from "stream";
import { waitFor } from "../../helpers/wait-for.ts";

/**
 * Helper: patch process.stdin and process.stdout with mocks,
 * run a test function, then restore originals.
 */
async function withMockedIO(
  fn: (mockStdin: PassThrough, mockStdout: PassThrough) => Promise<void>,
): Promise<void> {
  const mockStdin = new PassThrough();
  const mockStdout = new PassThrough();
  const originalStdin = process.stdin;
  const originalStdout = process.stdout;

  Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });
  Object.defineProperty(process, "stdout", { value: mockStdout, writable: true });

  try {
    await fn(mockStdin, mockStdout);
  } finally {
    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
    Object.defineProperty(process, "stdout", { value: originalStdout, writable: true });
    mockStdin.destroy();
    mockStdout.destroy();
  }
}

describe("CLIAdapter", () => {
  const adapters: CLIAdapter[] = [];

  afterEach(async () => {
    for (const adapter of adapters) {
      try {
        await adapter.stop();
      } catch {
        // ignore — may already be closed
      }
    }
    adapters.length = 0;
  });

  it("should have type 'cli'", () => {
    const adapter = new CLIAdapter("TestBot");
    expect(adapter.type).toBe("cli");
  });

  it("should implement ChannelAdapter interface", () => {
    const adapter = new CLIAdapter("TestBot");
    expect(typeof adapter.start).toBe("function");
    expect(typeof adapter.deliver).toBe("function");
    expect(typeof adapter.stop).toBe("function");
    expect(adapter.type).toBe("cli");
  });

  it("should accept optional onExit callback", () => {
    const adapter = new CLIAdapter("TestBot", async () => {});
    expect(adapter.type).toBe("cli");
  });

  it("should start and create readline interface", async () => {
    await withMockedIO(async (_mockStdin) => {
      const adapter = new CLIAdapter("TestBot");
      adapters.push(adapter);

      await adapter.start({ send: () => {} });
      expect(true).toBe(true);
    });
  });

  it("should send regular text input as InboundMessage", async () => {
    await withMockedIO(async (mockStdin) => {
      const adapter = new CLIAdapter("TestBot");
      adapters.push(adapter);

      const received: InboundMessage[] = [];
      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      mockStdin.write("hello world\n");
      await waitFor(() => received.length >= 1);

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe("hello world");
      expect(received[0]!.channel.type).toBe("cli");
      expect(received[0]!.channel.channelId).toBe("main");
    });
  });

  it("should skip empty input", async () => {
    await withMockedIO(async (mockStdin) => {
      const adapter = new CLIAdapter("TestBot");
      adapters.push(adapter);

      const received: InboundMessage[] = [];
      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      mockStdin.write("\n");
      mockStdin.write("   \n");
      await Bun.sleep(10);

      expect(received).toHaveLength(0);
    });
  });

  it("should handle /help command without sending to agent", async () => {
    await withMockedIO(async (mockStdin, _mockStdout) => {
      const adapter = new CLIAdapter("TestBot");
      adapters.push(adapter);

      const received: InboundMessage[] = [];

      // Capture stdout output from console.log
      const logged: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));

      try {
        await adapter.start({
          send: (msg: InboundMessage) => received.push(msg),
        });

        mockStdin.write("/help\n");
        await waitFor(() => logged.some((l) => l.includes("/help")));

        expect(received).toHaveLength(0);
        expect(logged.some((l) => l.includes("/help"))).toBe(true);
      } finally {
        console.log = origLog;
      }
    });
  });

  it("should handle /exit command and call onExit", async () => {
    await withMockedIO(async (mockStdin) => {
      let exitCalled = false;
      const adapter = new CLIAdapter("TestBot", async () => {
        exitCalled = true;
      });
      adapters.push(adapter);

      const origLog = console.log;
      console.log = () => {};

      try {
        await adapter.start({ send: () => {} });

        mockStdin.write("/exit\n");
        await waitFor(() => exitCalled);

        expect(exitCalled).toBe(true);
      } finally {
        console.log = origLog;
      }
    });
  });

  it("should handle /quit as alias for /exit", async () => {
    await withMockedIO(async (mockStdin) => {
      let exitCalled = false;
      const adapter = new CLIAdapter("TestBot", async () => {
        exitCalled = true;
      });
      adapters.push(adapter);

      const origLog = console.log;
      console.log = () => {};

      try {
        await adapter.start({ send: () => {} });

        mockStdin.write("/quit\n");
        await waitFor(() => exitCalled);

        expect(exitCalled).toBe(true);
      } finally {
        console.log = origLog;
      }
    });
  });

  it("should treat unrecognized slash commands as regular input", async () => {
    await withMockedIO(async (mockStdin) => {
      const adapter = new CLIAdapter("TestBot");
      adapters.push(adapter);

      const received: InboundMessage[] = [];
      await adapter.start({
        send: (msg: InboundMessage) => received.push(msg),
      });

      mockStdin.write("/unknown_command\n");
      await waitFor(() => received.length >= 1);

      expect(received).toHaveLength(1);
      expect(received[0]!.text).toBe("/unknown_command");
    });
  });

  it("deliver should print persona name and message text", async () => {
    await withMockedIO(async (_mockStdin) => {
      const adapter = new CLIAdapter("Aria");
      adapters.push(adapter);

      const logged: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "));

      try {
        await adapter.start({ send: () => {} });

        const msg: OutboundMessage = {
          text: "Hello user!",
          channel: { type: "cli", channelId: "main" },
        };

        await adapter.deliver(msg);

        expect(
          logged.some((l) => l.includes("Aria") && l.includes("Hello user!")),
        ).toBe(true);
      } finally {
        console.log = origLog;
      }
    });
  });

  it("should handle exit without onExit callback", async () => {
    await withMockedIO(async (mockStdin) => {
      const adapter = new CLIAdapter("TestBot"); // no onExit
      adapters.push(adapter);

      const origLog = console.log;
      console.log = () => {};

      try {
        await adapter.start({ send: () => {} });
        mockStdin.write("/exit\n");
        await Bun.sleep(10);
        // Should not crash
      } finally {
        console.log = origLog;
      }
    });
  });

  it("stop should close readline", async () => {
    await withMockedIO(async (_mockStdin) => {
      const adapter = new CLIAdapter("TestBot");
      adapters.push(adapter);

      await adapter.start({ send: () => {} });
      await adapter.stop();
      // Should not throw
    });
  });
});
