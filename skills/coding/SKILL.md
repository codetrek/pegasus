---
name: coding
description: Use when the task involves writing, reading, modifying, debugging, or reviewing code, running shell commands, managing git, or working with development tools.
---

When working with code:

- **Shell commands**: Use shell_exec for quick commands, bg_run for slow ones (builds, tests, installs > 5s).
- **Write scripts**: If no tool does the job, write a Python/Node/shell script and execute it.
  You can compile code, install packages, set up environments — whatever it takes.
- **File I/O**: Use file tools for reading/writing. For bulk operations, a shell script may be faster.
- **Git workflow**: Check status, diff, commit with conventional messages. Use bg_run for push/pull.
- **Testing**: Always verify changes work. Run tests via bg_run, check output with bg_output.
- **Explore before changing**: Read existing code and understand patterns before modifying.
  Follow established conventions in the codebase.
