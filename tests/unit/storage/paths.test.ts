import { describe, it, expect } from "bun:test";
import {
  buildMainAgentPaths,
  buildSubAgentPaths,
  buildProjectAgentPaths,
} from "@pegasus/storage/paths.ts";
import type { AgentStorePaths } from "@pegasus/storage/paths.ts";

describe("AgentStorePaths", () => {
  describe("buildMainAgentPaths", () => {
    it("should construct paths under dataDir/agents/main", () => {
      const paths: AgentStorePaths = buildMainAgentPaths("/data");
      expect(paths.session).toBe("/data/agents/main/session");
      expect(paths.subagents).toBe("/data/agents/main/subagents");
      expect(paths.memory).toBe("/data/agents/main/memory");
    });
  });

  describe("buildSubAgentPaths", () => {
    it("should construct paths under subagentDir with no memory", () => {
      const paths: AgentStorePaths = buildSubAgentPaths(
        "/data/agents/subagents/sa_1_123",
      );
      expect(paths.session).toBe("/data/agents/subagents/sa_1_123/session");
      expect(paths.subagents).toBe("/data/agents/subagents/sa_1_123/subagents");
      expect(paths.memory).toBeUndefined();
    });
  });

  describe("buildProjectAgentPaths", () => {
    it("should construct paths under projectDir", () => {
      const paths: AgentStorePaths = buildProjectAgentPaths(
        "/data/agents/projects/myproject",
      );
      expect(paths.session).toBe("/data/agents/projects/myproject/session");
      expect(paths.subagents).toBe("/data/agents/projects/myproject/subagents");
      expect(paths.memory).toBe("/data/agents/projects/myproject/memory");
    });
  });
});
