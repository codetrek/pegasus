/**
 * Image hydration — determines which images get base64 injected
 * before sending messages to the LLM.
 *
 * Strategy: hydrate images in the last N turns, older ones stay as refs.
 * A "turn" boundary is defined by assistant messages.
 */
import type { Message } from "../infra/llm-types.ts";

type ReadFn = (id: string) => Promise<{ data: string; mimeType: string } | null>;

/**
 * Hydrate images in recent messages for LLM consumption.
 * Returns a new array — does not mutate input.
 *
 * @param messages - conversation history
 * @param keepLastNTurns - how many recent turns to hydrate images for
 * @param readFn - function to read image base64 by ID
 */
export async function hydrateImages(
  messages: Message[],
  keepLastNTurns: number,
  readFn: ReadFn,
): Promise<Message[]> {
  if (messages.length === 0 || keepLastNTurns <= 0) return [...messages];

  // Find cutoff index
  const cutoffIndex = findCutoffIndex(messages, keepLastNTurns);

  // Deep-copy messages (shallow copy each message, deep copy images array)
  const result: Message[] = messages.map((m) => ({
    ...m,
    images: m.images ? m.images.map((img) => ({ ...img })) : undefined,
  }));

  // Hydrate images at/after cutoff
  const promises: Promise<void>[] = [];

  for (let i = cutoffIndex; i < result.length; i++) {
    const msg = result[i]!;
    if (!msg.images) continue;

    for (const img of msg.images) {
      if (img.data) continue; // Already hydrated
      promises.push(
        readFn(img.id).then((data) => {
          if (data) {
            img.data = data.data;
          }
        }),
      );
    }
  }

  await Promise.all(promises);
  return result;
}

/**
 * Find the message index where hydration should start.
 * Counts N assistant messages backwards from the end.
 */
function findCutoffIndex(messages: Message[], keepLastNTurns: number): number {
  let assistantCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      assistantCount++;
      if (assistantCount >= keepLastNTurns) {
        return i;
      }
    }
  }

  // Fewer than N assistant messages — hydrate everything
  return 0;
}

// Export for testing
export { findCutoffIndex };
