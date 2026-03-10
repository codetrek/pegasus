import { describe, it, expect } from "bun:test";
import { SettingsSchema } from "../../../src/infra/config-schema.ts";

describe("Vision config", () => {
  it("should have sensible defaults when not specified", () => {
    const settings = SettingsSchema.parse({
      dataDir: "/tmp/test",
      homeDir: "/tmp/test-home",
    });
    expect(settings.vision).toBeDefined();
    expect(settings.vision.enabled).toBe(true);
    expect(settings.vision.keepLastNTurns).toBe(5);
    expect(settings.vision.maxDimensionPx).toBe(1200);
    expect(settings.vision.maxImageBytes).toBe(5 * 1024 * 1024);
  });

  it("should allow overriding all fields", () => {
    const settings = SettingsSchema.parse({
      dataDir: "/tmp/test",
      homeDir: "/tmp/test-home",
      vision: {
        enabled: false,
        keepLastNTurns: 3,
        maxDimensionPx: 800,
        maxImageBytes: 1000000,
      },
    });
    expect(settings.vision.enabled).toBe(false);
    expect(settings.vision.keepLastNTurns).toBe(3);
    expect(settings.vision.maxDimensionPx).toBe(800);
    expect(settings.vision.maxImageBytes).toBe(1000000);
  });

  it("should handle string 'false' for enabled (from env vars)", () => {
    const settings = SettingsSchema.parse({
      dataDir: "/tmp/test",
      homeDir: "/tmp/test-home",
      vision: { enabled: "false" },
    });
    expect(settings.vision.enabled).toBe(false);
  });

  it("should handle string 'true' for enabled (from env vars)", () => {
    const settings = SettingsSchema.parse({
      dataDir: "/tmp/test",
      homeDir: "/tmp/test-home",
      vision: { enabled: "true" },
    });
    expect(settings.vision.enabled).toBe(true);
  });

  it("should coerce string numbers", () => {
    const settings = SettingsSchema.parse({
      dataDir: "/tmp/test",
      homeDir: "/tmp/test-home",
      vision: {
        keepLastNTurns: "10",
        maxDimensionPx: "800",
      },
    });
    expect(settings.vision.keepLastNTurns).toBe(10);
    expect(settings.vision.maxDimensionPx).toBe(800);
  });

  it("should allow partial override (other fields keep defaults)", () => {
    const settings = SettingsSchema.parse({
      dataDir: "/tmp/test",
      homeDir: "/tmp/test-home",
      vision: { keepLastNTurns: 2 },
    });
    expect(settings.vision.keepLastNTurns).toBe(2);
    expect(settings.vision.enabled).toBe(true); // default
    expect(settings.vision.maxDimensionPx).toBe(1200); // default
  });
});
