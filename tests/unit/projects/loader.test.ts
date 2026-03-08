/**
 * Unit tests for ProjectLoader — PROJECT.md parsing and directory scanning.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import path from "node:path";
import {
  splitFrontmatter,
  parseProjectFile,
  scanProjectDir,
} from "../../../src/projects/loader.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = `/tmp/pegasus-test-project-loader-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function writeProjectFile(dir: string, projectName: string, content: string): string {
  const projectDir = path.join(dir, projectName);
  mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, "PROJECT.md");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ── splitFrontmatter ──────────────────────────────────────────

describe("splitFrontmatter", () => {
  it("should split valid frontmatter from body", () => {
    const content = `---
name: my-project
status: active
---
# Project Body

Some instructions here.`;

    const result = splitFrontmatter(content);
    expect(result.frontmatter).toBe("name: my-project\nstatus: active");
    expect(result.body).toBe("# Project Body\n\nSome instructions here.");
  });

  it("should return null frontmatter when no --- markers", () => {
    const content = "Just plain markdown content.\n\nNo frontmatter here.";
    const result = splitFrontmatter(content);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe("Just plain markdown content.\n\nNo frontmatter here.");
  });
});

// ── parseProjectFile ──────────────────────────────────────────

describe("parseProjectFile", () => {
  it("should parse valid PROJECT.md with all frontmatter fields", () => {
    const dir = makeTmpDir();
    const content = `---
name: research-agent
status: active
model: gpt-4o
workdir: /home/user/research
created: "2025-01-15T10:00:00Z"
---
# Research Agent

You are a research assistant that investigates topics.`;

    const filePath = writeProjectFile(dir, "research-agent", content);
    const project = parseProjectFile(filePath, "research-agent");

    expect(project).not.toBeNull();
    expect(project!.name).toBe("research-agent");
    expect(project!.status).toBe("active");
    expect(project!.model).toBe("gpt-4o");
    expect(project!.workdir).toBe("/home/user/research");
    expect(project!.created).toBe("2025-01-15T10:00:00Z");
    expect(project!.prompt).toBe("# Research Agent\n\nYou are a research assistant that investigates topics.");
    expect(project!.projectDir).toBe(path.join(dir, "research-agent"));
  });

  it("should parse minimal PROJECT.md with only required fields", () => {
    const dir = makeTmpDir();
    const content = `---
name: minimal
status: active
---
Do minimal work.`;

    const filePath = writeProjectFile(dir, "minimal", content);
    const project = parseProjectFile(filePath, "minimal");

    expect(project).not.toBeNull();
    expect(project!.name).toBe("minimal");
    expect(project!.status).toBe("active");
    expect(project!.model).toBeUndefined();
    expect(project!.workdir).toBeUndefined();
    expect(project!.created).toBeDefined(); // auto-generated
    expect(project!.prompt).toBe("Do minimal work.");
  });

  it("should return null if name doesn't match directory", () => {
    const dir = makeTmpDir();
    const content = `---
name: different-name
status: active
---
Body.`;

    const filePath = writeProjectFile(dir, "actual-dir-name", content);
    const project = parseProjectFile(filePath, "actual-dir-name");

    expect(project).toBeNull();
  });

  it("should return null for invalid status", () => {
    const dir = makeTmpDir();
    const content = `---
name: bad-status
status: running
---
Body.`;

    const filePath = writeProjectFile(dir, "bad-status", content);
    const project = parseProjectFile(filePath, "bad-status");

    expect(project).toBeNull();
  });

  it("should return null for missing frontmatter", () => {
    const dir = makeTmpDir();
    const content = "Just a plain markdown file without frontmatter.";

    const filePath = writeProjectFile(dir, "no-frontmatter", content);
    const project = parseProjectFile(filePath, "no-frontmatter");

    expect(project).toBeNull();
  });

  it("should default status to active when not specified", () => {
    const dir = makeTmpDir();
    const content = `---
name: no-status
---
Body.`;

    const filePath = writeProjectFile(dir, "no-status", content);
    const project = parseProjectFile(filePath, "no-status");

    expect(project).not.toBeNull();
    expect(project!.status).toBe("active");
  });

  it("should use dirName when name not in frontmatter", () => {
    const dir = makeTmpDir();
    const content = `---
status: active
---
Body.`;

    const filePath = writeProjectFile(dir, "from-dir", content);
    const project = parseProjectFile(filePath, "from-dir");

    expect(project).not.toBeNull();
    expect(project!.name).toBe("from-dir");
  });

  it("should return null for non-existent file", () => {
    const project = parseProjectFile("/tmp/does-not-exist/PROJECT.md", "ghost");
    expect(project).toBeNull();
  });

  it("should parse disabled project with timestamp", () => {
    const dir = makeTmpDir();
    const content = `---
name: paused-project
status: disabled
created: "2025-01-10T08:00:00Z"
disabled: "2025-01-20T12:00:00Z"
---
This project is paused.`;

    const filePath = writeProjectFile(dir, "paused-project", content);
    const project = parseProjectFile(filePath, "paused-project");

    expect(project).not.toBeNull();
    expect(project!.status).toBe("disabled");
    expect(project!.disabled).toBe("2025-01-20T12:00:00Z");
  });

  it("should parse archived project", () => {
    const dir = makeTmpDir();
    const content = `---
name: done-project
status: archived
created: "2025-01-10T08:00:00Z"
---
This project is done.`;

    const filePath = writeProjectFile(dir, "done-project", content);
    const project = parseProjectFile(filePath, "done-project");

    expect(project).not.toBeNull();
    expect(project!.status).toBe("archived");
  });
});

// ── scanProjectDir ────────────────────────────────────────────

describe("scanProjectDir", () => {
  it("should discover all PROJECT.md files in subdirectories", () => {
    const dir = makeTmpDir();
    writeProjectFile(dir, "project-a", `---
name: project-a
status: active
---
Body A.`);
    writeProjectFile(dir, "project-b", `---
name: project-b
status: disabled
---
Body B.`);

    const projects = scanProjectDir(dir);
    expect(projects.length).toBe(2);

    const names = projects.map((p) => p.name).sort();
    expect(names).toEqual(["project-a", "project-b"]);
  });

  it("should skip directories without PROJECT.md", () => {
    const dir = makeTmpDir();
    writeProjectFile(dir, "with-project", `---
name: with-project
status: active
---
Has a PROJECT.md.`);
    // Directory without PROJECT.md
    mkdirSync(path.join(dir, "empty-dir"), { recursive: true });

    const projects = scanProjectDir(dir);
    expect(projects.length).toBe(1);
    expect(projects[0]!.name).toBe("with-project");
  });

  it("should return empty array for non-existent directory", () => {
    const projects = scanProjectDir("/tmp/pegasus-nonexistent-project-dir-xyz");
    expect(projects).toEqual([]);
  });

  it("should skip non-directory entries", () => {
    const dir = makeTmpDir();
    writeProjectFile(dir, "valid-project", `---
name: valid-project
status: active
---
Content.`);
    // Create a plain file (not a directory) in the scan root
    writeFileSync(path.join(dir, "not-a-dir.txt"), "just a file");

    const projects = scanProjectDir(dir);
    expect(projects.length).toBe(1);
    expect(projects[0]!.name).toBe("valid-project");
  });

  it("should skip projects with invalid definitions", () => {
    const dir = makeTmpDir();
    writeProjectFile(dir, "good-project", `---
name: good-project
status: active
---
Valid.`);
    writeProjectFile(dir, "bad-project", `---
name: wrong-name
status: active
---
Name doesn't match dir.`);

    const projects = scanProjectDir(dir);
    expect(projects.length).toBe(1);
    expect(projects[0]!.name).toBe("good-project");
  });
});
