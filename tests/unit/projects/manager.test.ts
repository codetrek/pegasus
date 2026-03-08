/**
 * Unit tests for ProjectManager — lifecycle FSM, directory creation, status transitions.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import path from "node:path";
import { ProjectManager } from "../../../src/projects/manager.ts";
import { splitFrontmatter } from "../../../src/projects/loader.ts";
import yaml from "js-yaml";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = `/tmp/pegasus-test-project-manager-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

/** Write a PROJECT.md inside <dir>/<name>/PROJECT.md. */
function writeProjectFile(dir: string, projectName: string, content: string): void {
  const projectDir = path.join(dir, projectName);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, "PROJECT.md"), content, "utf-8");
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ── loadAll ─────────────────────────────────────────────────

describe("ProjectManager.loadAll", () => {
  it("should discover existing projects from directory", () => {
    const dir = makeTmpDir();
    writeProjectFile(dir, "alpha", `---
name: alpha
status: active
---
Alpha project.`);
    writeProjectFile(dir, "beta", `---
name: beta
status: disabled
---
Beta project.`);

    const mgr = new ProjectManager(dir);
    mgr.loadAll();

    expect(mgr.get("alpha")).not.toBeNull();
    expect(mgr.get("alpha")!.status).toBe("active");
    expect(mgr.get("beta")).not.toBeNull();
    expect(mgr.get("beta")!.status).toBe("disabled");
  });
});

// ── create ──────────────────────────────────────────────────

describe("ProjectManager.create", () => {
  it("should create directory structure and PROJECT.md, register with status active", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);

    const def = mgr.create({
      name: "my-project",
      goal: "Build something great",
      background: "We need automation",
      constraints: "Must be fast",
      model: "gpt-4o",
      workdir: "/home/user/work",
    });

    // Verify returned definition
    expect(def.name).toBe("my-project");
    expect(def.status).toBe("active");
    expect(def.model).toBe("gpt-4o");
    expect(def.workdir).toBe("/home/user/work");
    expect(def.created).toBeDefined();
    expect(def.projectDir).toBe(path.join(dir, "my-project"));

    // Verify directory structure
    const projectDir = path.join(dir, "my-project");
    expect(existsSync(path.join(projectDir, "session"))).toBe(true);
    expect(existsSync(path.join(projectDir, "memory/facts"))).toBe(true);
    expect(existsSync(path.join(projectDir, "memory/episodes"))).toBe(true);
    expect(existsSync(path.join(projectDir, "tasks"))).toBe(true);
    expect(existsSync(path.join(projectDir, "skills"))).toBe(true);

    // Verify PROJECT.md exists
    const mdPath = path.join(projectDir, "PROJECT.md");
    expect(existsSync(mdPath)).toBe(true);

    // Verify it can be parsed back
    const content = readFileSync(mdPath, "utf-8");
    const { frontmatter } = splitFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    const fm = yaml.load(frontmatter!) as Record<string, string>;
    expect(fm.name).toBe("my-project");
    expect(fm.status).toBe("active");
    expect(fm.model).toBe("gpt-4o");

    // Verify in-memory registration
    expect(mgr.get("my-project")).not.toBeNull();
    expect(mgr.get("my-project")!.status).toBe("active");
  });

  it("should reject duplicate project name", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);

    mgr.create({ name: "dup-project", goal: "First" });

    expect(() => mgr.create({ name: "dup-project", goal: "Second" })).toThrow(
      'Project "dup-project" already exists',
    );
  });

  it("should write PROJECT.md body with goal, background, constraints", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);

    mgr.create({
      name: "rich-project",
      goal: "Automate everything",
      background: "Manual processes are slow",
      constraints: "Budget limited to $100",
    });

    const mdPath = path.join(dir, "rich-project", "PROJECT.md");
    const content = readFileSync(mdPath, "utf-8");
    const { body } = splitFrontmatter(content);

    expect(body).toContain("## Goal");
    expect(body).toContain("Automate everything");
    expect(body).toContain("## Background");
    expect(body).toContain("Manual processes are slow");
    expect(body).toContain("## Constraints");
    expect(body).toContain("Budget limited to $100");
  });

  it("should write PROJECT.md body with only goal when no background/constraints", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);

    mgr.create({ name: "minimal-project", goal: "Just a goal" });

    const mdPath = path.join(dir, "minimal-project", "PROJECT.md");
    const content = readFileSync(mdPath, "utf-8");
    const { body } = splitFrontmatter(content);

    expect(body).toContain("## Goal");
    expect(body).toContain("Just a goal");
    expect(body).not.toContain("## Background");
    expect(body).not.toContain("## Constraints");
  });
});

// ── status transitions ──────────────────────────────────────

describe("ProjectManager.disable", () => {
  it("should transition active → disabled, updates PROJECT.md file", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);
    mgr.create({ name: "to-disable", goal: "Test disable" });

    mgr.disable("to-disable");

    // In-memory state updated
    const def = mgr.get("to-disable")!;
    expect(def.status).toBe("disabled");
    expect(def.disabled).toBeDefined();

    // PROJECT.md on disk updated
    const content = readFileSync(path.join(dir, "to-disable", "PROJECT.md"), "utf-8");
    const { frontmatter, body } = splitFrontmatter(content);
    const fm = yaml.load(frontmatter!) as Record<string, string>;
    expect(fm.status).toBe("disabled");
    expect(fm.disabled).toBeDefined();

    // Body preserved
    expect(body).toContain("## Goal");
    expect(body).toContain("Test disable");
  });
});

describe("ProjectManager.enable", () => {
  it("should transition disabled → active", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);
    mgr.create({ name: "to-enable", goal: "Test enable" });
    mgr.disable("to-enable");

    mgr.enable("to-enable");

    const def = mgr.get("to-enable")!;
    expect(def.status).toBe("active");
    expect(def.disabled).toBeUndefined();

    // Verify on disk
    const content = readFileSync(path.join(dir, "to-enable", "PROJECT.md"), "utf-8");
    const fm = yaml.load(splitFrontmatter(content).frontmatter!) as Record<string, string>;
    expect(fm.status).toBe("active");
    expect(fm.disabled).toBeUndefined();
  });
});

describe("ProjectManager.archive", () => {
  it("should transition active → archived", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);
    mgr.create({ name: "to-archive", goal: "Test archive" });

    mgr.archive("to-archive");

    const def = mgr.get("to-archive")!;
    expect(def.status).toBe("archived");
  });

  it("should transition disabled → archived", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);
    mgr.create({ name: "to-archive-disabled", goal: "Test archive from disabled" });
    mgr.disable("to-archive-disabled");

    mgr.archive("to-archive-disabled");

    const def = mgr.get("to-archive-disabled")!;
    expect(def.status).toBe("archived");
  });
});

// ── invalid transitions ─────────────────────────────────────

describe("ProjectManager invalid transitions", () => {
  it("should throw for archived → active", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);
    mgr.create({ name: "archived-project", goal: "Test" });
    mgr.archive("archived-project");

    expect(() => mgr.enable("archived-project")).toThrow(
      'Invalid transition: cannot move project "archived-project" from "archived" to "active"',
    );
  });

  it("should throw for archived → disabled", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);
    mgr.create({ name: "archived-project2", goal: "Test" });
    mgr.archive("archived-project2");

    expect(() => mgr.disable("archived-project2")).toThrow(
      'Invalid transition: cannot move project "archived-project2" from "archived" to "disabled"',
    );
  });

  it("should throw for unknown project", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);

    expect(() => mgr.disable("nonexistent")).toThrow(
      'Project "nonexistent" not found',
    );
  });
});

// ── list ────────────────────────────────────────────────────

describe("ProjectManager.list", () => {
  it("should filter by status", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);
    mgr.create({ name: "proj-active", goal: "Active" });
    mgr.create({ name: "proj-disabled", goal: "Disabled" });
    mgr.disable("proj-disabled");

    const active = mgr.list("active");
    expect(active.length).toBe(1);
    expect(active[0]!.name).toBe("proj-active");

    const disabled = mgr.list("disabled");
    expect(disabled.length).toBe(1);
    expect(disabled[0]!.name).toBe("proj-disabled");

    const all = mgr.list();
    expect(all.length).toBe(2);
  });
});

// ── get ─────────────────────────────────────────────────────

describe("ProjectManager.get", () => {
  it("should return null for unknown project", () => {
    const dir = makeTmpDir();
    const mgr = new ProjectManager(dir);

    expect(mgr.get("does-not-exist")).toBeNull();
  });
});
