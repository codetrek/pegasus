/**
 * Tests for SubAgentTypeLoader — SUBAGENT.md parsing and directory scanning.
 *
 * Covers frontmatter parsing, model field extraction, name validation,
 * tool parsing, and multi-directory scanning with source tagging.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import path from "node:path";
import { tmpdir } from "os";
import { parseSubAgentTypeFile, scanSubAgentTypeDir, loadSubAgentTypeDefinitions } from "@pegasus/agents/subagents/loader.ts";

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "subagent-type-loader-test-"));
}

function writeSubAgentMd(dir: string, name: string, content: string): string {
  const subDir = path.join(dir, name);
  mkdirSync(subDir, { recursive: true });
  const filePath = path.join(subDir, "SUBAGENT.md");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("parseSubAgentTypeFile", () => {
  test("parses basic frontmatter fields", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubAgentMd(tmp, "test-agent", `---
name: test-agent
description: "A test agent"
tools: "read_file, grep_files"
---

You are a test agent.
`);
      const def = parseSubAgentTypeFile(filePath, "test-agent", "builtin");
      expect(def).not.toBeNull();
      expect(def!.name).toBe("test-agent");
      expect(def!.description).toBe("A test agent");
      expect(def!.tools).toEqual(["read_file", "grep_files"]);
      expect(def!.prompt).toBe("You are a test agent.");
      expect(def!.source).toBe("builtin");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("model field is parsed from frontmatter (tier name)", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubAgentMd(tmp, "explore", `---
name: explore
description: "Explorer agent"
tools: "*"
model: fast
---

Explore things.
`);
      const def = parseSubAgentTypeFile(filePath, "explore", "builtin");
      expect(def).not.toBeNull();
      expect(def!.model).toBe("fast");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("model field is parsed from frontmatter (specific model spec)", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubAgentMd(tmp, "custom", `---
name: custom
description: "Custom agent"
tools: "*"
model: openai/gpt-4o-mini
---

Custom prompt.
`);
      const def = parseSubAgentTypeFile(filePath, "custom", "user");
      expect(def).not.toBeNull();
      expect(def!.model).toBe("openai/gpt-4o-mini");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("model field is undefined when not specified", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubAgentMd(tmp, "no-model", `---
name: no-model
description: "Agent without model"
tools: "*"
---

No model specified.
`);
      const def = parseSubAgentTypeFile(filePath, "no-model", "builtin");
      expect(def).not.toBeNull();
      expect(def!.model).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("tier names (fast, balanced, powerful) are passed through as-is", () => {
    const tmp = makeTmpDir();
    try {
      for (const tier of ["fast", "balanced", "powerful"]) {
        const filePath = writeSubAgentMd(tmp, `agent-${tier}`, `---
name: agent-${tier}
description: "Agent with ${tier} tier"
tools: "*"
model: ${tier}
---

Prompt.
`);
        const def = parseSubAgentTypeFile(filePath, `agent-${tier}`, "builtin");
        expect(def).not.toBeNull();
        expect(def!.model).toBe(tier);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("specific model specs are passed through as-is", () => {
    const tmp = makeTmpDir();
    try {
      const specs = ["openai/gpt-4o", "anthropic/claude-sonnet-4", "openai/gpt-4o-mini"];
      for (const spec of specs) {
        const safeName = spec.replace(/\//g, "-");
        const filePath = writeSubAgentMd(tmp, safeName, `---
name: ${safeName}
description: "Agent with ${spec}"
tools: "*"
model: ${spec}
---

Prompt.
`);
        const def = parseSubAgentTypeFile(filePath, safeName, "user");
        expect(def).not.toBeNull();
        expect(def!.model).toBe(spec);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("uses dirName as name when frontmatter name is missing", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubAgentMd(tmp, "fallback-name", `---
description: "No name field"
tools: "*"
---

Body.
`);
      const def = parseSubAgentTypeFile(filePath, "fallback-name", "builtin");
      expect(def).not.toBeNull();
      expect(def!.name).toBe("fallback-name");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("tools '*' expands to wildcard array", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubAgentMd(tmp, "wildcard", `---
name: wildcard
description: "Wildcard tools"
tools: "*"
---

Body.
`);
      const def = parseSubAgentTypeFile(filePath, "wildcard", "builtin");
      expect(def).not.toBeNull();
      expect(def!.tools).toEqual(["*"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns null for invalid name", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubAgentMd(tmp, "INVALID_NAME", `---
name: INVALID_NAME
description: "Bad name"
tools: "*"
---

Body.
`);
      const def = parseSubAgentTypeFile(filePath, "INVALID_NAME", "builtin");
      expect(def).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("handles missing frontmatter gracefully", () => {
    const tmp = makeTmpDir();
    try {
      const filePath = writeSubAgentMd(tmp, "no-fm", "Just a markdown body.");
      const def = parseSubAgentTypeFile(filePath, "no-fm", "builtin");
      expect(def).not.toBeNull();
      expect(def!.name).toBe("no-fm");
      expect(def!.tools).toEqual(["*"]);
      expect(def!.model).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("scanSubAgentTypeDir", () => {
  test("discovers AI task types in directory", () => {
    const tmp = makeTmpDir();
    try {
      writeSubAgentMd(tmp, "agent-a", `---
name: agent-a
description: "Agent A"
tools: "*"
model: fast
---

A prompt.
`);
      writeSubAgentMd(tmp, "agent-b", `---
name: agent-b
description: "Agent B"
tools: "*"
---

B prompt.
`);
      const defs = scanSubAgentTypeDir(tmp, "builtin");
      expect(defs.length).toBe(2);
      const names = defs.map((d) => d.name).sort();
      expect(names).toEqual(["agent-a", "agent-b"]);

      const agentA = defs.find((d) => d.name === "agent-a");
      expect(agentA!.model).toBe("fast");

      const agentB = defs.find((d) => d.name === "agent-b");
      expect(agentB!.model).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns empty array for nonexistent directory", () => {
    const defs = scanSubAgentTypeDir("/nonexistent/path/xyz", "user");
    expect(defs).toEqual([]);
  });
});

describe("loadSubAgentTypeDefinitions", () => {
  test("merges builtin and user AI task types", () => {
    const builtinDir = makeTmpDir();
    const userDir = makeTmpDir();
    try {
      writeSubAgentMd(builtinDir, "explore", `---
name: explore
description: "Built-in explore"
tools: "*"
model: fast
---

Explore.
`);
      writeSubAgentMd(userDir, "custom", `---
name: custom
description: "User custom"
tools: "*"
model: openai/gpt-4o-mini
---

Custom.
`);
      const all = loadSubAgentTypeDefinitions(builtinDir, userDir);
      expect(all.length).toBe(2);

      const explore = all.find((d) => d.name === "explore");
      expect(explore!.source).toBe("builtin");
      expect(explore!.model).toBe("fast");

      const custom = all.find((d) => d.name === "custom");
      expect(custom!.source).toBe("user");
      expect(custom!.model).toBe("openai/gpt-4o-mini");
    } finally {
      rmSync(builtinDir, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  });
});
