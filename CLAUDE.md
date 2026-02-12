# CLAUDE.md - 开发指南

- Always disucss in "中文" with user and write document and code in English.
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

## 🔄 DECISION TREE

Before ANY file creation:

1. Can I modify existing file? → Do that
2. Is there a similar file? → Copy and modify
3. Neither? → Ask user first

Before ANY change:

1. Will this need new imports? → Check if already available

## 📝 HIERARCHY RULES

- Check for AGENTS.md in current directory
- Subdirectory rules compliment root rules
- If conflict → subdirectory wins

## Preference

- Uses `bun` for frontend package scripts.
- Tasks/plans are located in `docs/plans` folder
- Design docs are located in `docs/design` folder
