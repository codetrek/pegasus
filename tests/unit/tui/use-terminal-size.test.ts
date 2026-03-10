import { describe, it, expect } from "bun:test";
import { computeLayoutMode } from "@pegasus/tui/hooks/use-terminal-size.ts";

describe("computeLayoutMode", () => {
  it("returns 'columns' for width >= 120", () => {
    expect(computeLayoutMode(120)).toBe("columns");
    expect(computeLayoutMode(200)).toBe("columns");
  });

  it("returns 'tabs' for width < 120", () => {
    expect(computeLayoutMode(119)).toBe("tabs");
    expect(computeLayoutMode(80)).toBe("tabs");
    expect(computeLayoutMode(40)).toBe("tabs");
  });
});
