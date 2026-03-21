import { describe, it, expect } from "bun:test";
import { waitFor } from "./wait-for.ts";

describe("waitFor", () => {
  it("resolves immediately when condition is already true", async () => {
    await waitFor(() => true);
  });

  it("resolves when condition becomes true after polling", async () => {
    let count = 0;
    await waitFor(() => { count++; return count >= 3; }, 1000);
    expect(count).toBe(3);
  });

  it("works with async conditions", async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 20);
    await waitFor(async () => ready, 1000);
    expect(ready).toBe(true);
  });

  it("throws on timeout after multiple polls", async () => {
    let polls = 0;
    await expect(
      waitFor(() => { polls++; return false; }, 30, 5),
    ).rejects.toThrow("waitFor timed out after 30ms");
    // Should have polled multiple times before timing out
    expect(polls).toBeGreaterThan(1);
  });
});
