/**
 * Built-in tools - all available tools.
 */

import type { Tool } from "../types.ts";

// System tools
import * as systemToolsModule from "./system-tools.ts";
const current_time = systemToolsModule.current_time;
const sleep = systemToolsModule.sleep;
const get_env = systemToolsModule.get_env;
const set_env = systemToolsModule.set_env;

export { current_time, sleep, get_env, set_env };

// Shell tools
import * as shellToolsModule from "./shell-tools.ts";
const shell_exec = shellToolsModule.shell_exec;

export { shell_exec };

// File tools
import * as fileToolsModule from "./file-tools.ts";
const read_file = fileToolsModule.read_file;
const write_file = fileToolsModule.write_file;
const list_files = fileToolsModule.list_files;
const edit_file = fileToolsModule.edit_file;
const grep_files = fileToolsModule.grep_files;
const glob_files = fileToolsModule.glob_files;

export { read_file, write_file, list_files, edit_file, grep_files, glob_files };

// Network tools
import * as networkToolsModule from "./network-tools.ts";
const http_get = networkToolsModule.http_get;
const http_post = networkToolsModule.http_post;
const http_request = networkToolsModule.http_request;
const web_search = networkToolsModule.web_search;
const web_fetch = networkToolsModule.web_fetch;

export { http_get, http_post, http_request, web_search, web_fetch };

// Data tools
import * as dataToolsModule from "./data-tools.ts";
const base64_encode = dataToolsModule.base64_encode;
const base64_decode = dataToolsModule.base64_decode;

export { base64_encode, base64_decode };

// Memory tools
import * as memoryToolsModule from "./memory-tools.ts";
const memory_list = memoryToolsModule.memory_list;
const memory_read = memoryToolsModule.memory_read;
const memory_write = memoryToolsModule.memory_write;
const memory_patch = memoryToolsModule.memory_patch;
const memory_append = memoryToolsModule.memory_append;

export { memory_list, memory_read, memory_write, memory_patch, memory_append };

// Task tools
import * as taskToolsModule from "./task-tools.ts";
const task_list = taskToolsModule.task_list;
const task_replay = taskToolsModule.task_replay;

export { task_list, task_replay };

// Spawn subagent tool (for L1 agents — added by TaskRunner based on depth)
import * as spawnSubagentModule from "./spawn-subagent-tool.ts";
const spawn_subagent = spawnSubagentModule.spawn_subagent;

export { spawn_subagent };

// Resume subagent tool (for L1 agents — added by TaskRunner based on depth)
import * as resumeSubagentModule from "./resume-subagent-tool.ts";
const resume_subagent = resumeSubagentModule.resume_subagent;

export { resume_subagent };

// Reply tool (for Main Agent inner monologue)
import * as replyToolModule from "./reply-tool.ts";
const reply = replyToolModule.reply;

export { reply };

// Skill tools (for Main Agent)
import * as skillToolModule from "./skill-tool.ts";
const use_skill = skillToolModule.use_skill;
import * as reloadSkillsModule from "./reload-skills-tool.ts";
const reload_skills = reloadSkillsModule.reload_skills;

export { use_skill, reload_skills };

// Project tools (for Main Agent)
import * as projectToolsModule from "./project-tools.ts";
const create_project = projectToolsModule.create_project;
const list_projects = projectToolsModule.list_projects;
const suspend_project = projectToolsModule.suspend_project;
const resume_project = projectToolsModule.resume_project;
const complete_project = projectToolsModule.complete_project;
const archive_project = projectToolsModule.archive_project;

export { create_project, list_projects, suspend_project, resume_project, complete_project, archive_project };
export { projectTools } from "./project-tools.ts";

// Trust tool (for Main Agent — owner identity management)
import * as trustToolModule from "./trust-tool.ts";
const trust = trustToolModule.trust;

export { trust };

// Notify tool (for Task Agent → MainAgent communication)
import * as notifyToolModule from "./notify-tool.ts";
const notify = notifyToolModule.notify;

export { notify };

// Task status tool (runtime task query)
import * as taskStatusModule from "./task-status-tool.ts";
const task_status = taskStatusModule.task_status;

export { task_status };

// Session tools
import * as sessionToolsModule from "./session-tools.ts";
const session_archive_read = sessionToolsModule.session_archive_read;

export { session_archive_read };

export const sessionTools: Tool[] = [
  session_archive_read,
];

// Image tools (media)
import * as imageToolsModule from "./image-tools.ts";
const image_read = imageToolsModule.image_read;

export { image_read };

export const imageTools: Tool[] = [image_read];

// Background tools (meta tools for background execution)
import * as backgroundToolsModule from "./background-tools.ts";
const bg_run = backgroundToolsModule.bg_run;
const bg_output = backgroundToolsModule.bg_output;
const bg_stop = backgroundToolsModule.bg_stop;

export { bg_run, bg_output, bg_stop };

// Browser tools (Playwright-based browser automation)
import {
  browser_navigate,
  browser_snapshot,
  browser_screenshot,
  browser_click,
  browser_type,
  browser_scroll,
  browser_close,
  browserTools as _browserTools,
} from "../browser/browser-tools.ts";

export { browser_navigate, browser_snapshot, browser_screenshot, browser_click, browser_type, browser_scroll, browser_close };

// Re-export all tools as arrays

/** System tools available to Task System. */
export const systemTools: Tool[] = [
  current_time,
  sleep,
  get_env,
  set_env,
  shell_exec,
];

export const fileTools: Tool[] = [
  read_file,
  write_file,
  list_files,
  edit_file,
  grep_files,
  glob_files,
];

export const networkTools: Tool[] = [
  web_fetch,
  web_search,
];

export const dataTools: Tool[] = [
  base64_encode,
  base64_decode,
];

export const memoryTools: Tool[] = [
  memory_list,
  memory_read,
  memory_write,
  memory_patch,
  memory_append,
];

export const taskTools: Tool[] = [
  task_list,
  task_replay,
];

export const backgroundTools: Tool[] = [
  bg_run,
  bg_output,
  bg_stop,
];

export { _browserTools as browserTools };

/** All tools for Task System (base set — does NOT include spawn_subagent or reply). */
export const allTaskTools: Tool[] = [
  ...systemTools,
  ...fileTools,
  ...networkTools,
  ...dataTools,
  ...memoryTools,
  ...taskTools,
  ...backgroundTools,
  ..._browserTools,
  ...imageTools,
  notify,
];

/** Tools for SubAgent Workers — base task tools + task_status for monitoring. spawn_subagent is added by TaskRunner based on depth. */
export const subAgentTools: Tool[] = [
  ...allTaskTools,
  task_status,
];

/** Tools for Main Agent (curated simple tools + spawn_subagent + resume_subagent + reply + project tools). */
export const mainAgentTools: Tool[] = [
  current_time,
  memory_list,
  memory_read,
  memory_write,
  memory_patch,
  memory_append,
  task_list,
  task_replay,
  task_status,
  session_archive_read,
  image_read,
  spawn_subagent,
  resume_subagent,
  reply,
  use_skill,
  reload_skills,
  create_project,
  list_projects,
  suspend_project,
  resume_project,
  complete_project,
  archive_project,
  trust,
];

/** Memory tools available to PostTaskReflector (no memory_list — info is pre-loaded). */
export const reflectionTools: Tool[] = [memory_read, memory_write, memory_patch, memory_append];

/** @deprecated Use allTaskTools or mainAgentTools instead. */
export const allBuiltInTools = allTaskTools;
