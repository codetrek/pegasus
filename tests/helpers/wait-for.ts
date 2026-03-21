/**
 * Test helper — poll a condition until it becomes true or times out.
 *
 * Replaces fixed `Bun.sleep(N)` calls with fast condition-based waiting.
 * Polls every `interval` ms so tests finish as soon as the condition is met
 * instead of always waiting the worst-case duration.
 *
 * Usage:
 *   await waitFor(() => replies.length >= 1);
 *   await waitFor(() => agent.isIdle(), 5000);
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 2000,
  interval = 5,
): Promise<void> {
  const deadline = Date.now() + timeout;
  // Check immediately first
  if (await condition()) return;
  // Then poll with sleep
  while (Date.now() < deadline) {
    await Bun.sleep(interval);
    if (await condition()) return;
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}
