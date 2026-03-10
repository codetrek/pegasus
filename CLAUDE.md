# CLAUDE.md - 开发指南

- Always discuss in "中文" with user and write document and code in English.
- Always run testing after code changes to ensure code quality.
- Always run `make coverage` to evaluate test coverage and fix as needed.
- Always ask "should I add more testing" and make robust but not over-engineering testing.
- Always document the "Why" (reasoning/analysis) alongside the "How" (decision/implementation) in design discussion documents.
- Reminder: Add timeout to test if potential stuck.
- Reminder: Fix everything in one pass—search globally first, then verify and echo back, so the user never has to repeat the same request.

## 🚨 STOP CONDITIONS

IMMEDIATELY STOP and ask user when:

- Authentication/permission errors
- Need to add new dependencies
- Creating new architectural patterns
- **Ambiguous Intent**: If user says "load task", "check this", or "investigate", ONLY analyze and plan. DO NOT CODE.

## 🚫 FORBIDDEN PATTERNS

- Start coding without a **confirmed plan** from the user.
- Adding "Generated with Claude Code", "via Happy", or any co-author credits in commit messages.
- **Git force push**: Never use `git push --force` or `git push -f`. Use `git push --force-with-lease` only when absolutely necessary and with explicit user consent.
- **NEVER push directly to main**: All changes must go through Pull Request workflow:
  1. Commit to feature branch
  2. Push feature branch to remote
  3. Create Pull Request
  4. Wait for CI to pass
  5. Merge to main (CI passed)
  6. DO NOT merge or push to main directly under any circumstances
- **NEVER delete or modify files under `data/`**: The `data/` directory contains live runtime data (sessions, task logs, memory). Never `rm -rf data/`, never clean up `data/` subdirectories. If you suspect test pollution, report it — do NOT delete.
- **NEVER delete files outside the working directory (except `/tmp`)**: Credential files (`~/.pegasus/auth/`, `~/.codex/`), user config files, and any other files outside the project working directory are OFF LIMITS. You may only READ them. To verify test pollution, compare mtime/content before and after — NEVER delete and recreate. The only exception is `/tmp` which is safe for test artifacts.
- **NEVER remove or modify worktrees you did not create**: Other worktrees (e.g., `/workspace/pegasus-1`) belong to the user or other sessions. Never run `git worktree remove` on them. If a worktree blocks an operation, STOP and ask the user — do NOT force-remove it.
- **NEVER modify `git-hooks/` or git hook configuration**: Do NOT edit, delete, or overwrite files in `git-hooks/`. Do NOT run `git config core.hooksPath` to change the hooks path. Do NOT modify `.git/hooks/` or any hook-related configuration. The hooks are managed by the user via `make install-hooks`.
- **NEVER modify `git-hooks/` or git hook configuration**: This rule is critical and bears repeating. The `git-hooks/` directory and `core.hooksPath` config are OFF LIMITS. Any modification breaks the pre-commit safety guard that prevents direct commits to main.
- **NEVER modify `git-hooks/` or git hook configuration**: Third and final reminder. If you encounter a hook failure, diagnose and fix your code — do NOT disable, bypass, or reconfigure the hooks.

## 🔄 DECISION TREE

Before ANY file creation:

1. Can I modify existing file? → Do that
2. Is there a similar file? → Copy and modify
3. Neither? → Ask user first

## Preference

- Uses `bun` as runtime and package manager.

## Git Worktree Workflow

When implementing new features:

1. Create a git worktree in `.worktrees/` directory: `git worktree add .worktrees/<feature-name> -b <branch-name>`
2. Do all development work inside the worktree
3. After the feature branch is merged to main, remove the worktree: `git worktree remove .worktrees/<feature-name>`
4. Keep `.worktrees/` gitignored — it is local workspace only

## Documentation

- `README.md` is the project introduction (capabilities and features).
- `docs/README.md` is the technical entry point. See it for architecture, project structure, and the full documentation map.
- `docs/` — persistent system design docs: architecture decisions, the "Why" behind designs. Survives implementation.
- `docs/plans/` — disposable implementation plans: step-by-step task lists, checklists. Gitignored. Delete after execution.
