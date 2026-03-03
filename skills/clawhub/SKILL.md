---
name: clawhub
description: Search, install, update, list, and remove skills from the ClawHub marketplace (clawhub.com).
argument-hint: "<search|install|update|list|remove> [args]"
---

# ClawHub Skill Manager

Manage skills from the ClawHub marketplace via the `clawhub` CLI.

## Pre-check

Verify clawhub CLI is installed:

```bash
which clawhub
```

If not found, tell the user to install it:

```
npm i -g clawhub
```

Then stop and wait for them to confirm installation.

## Parse Command

Parse `$ARGUMENTS` — the first word is the sub-command, the rest are arguments.

## Scope

For install/update/remove, determine where to operate. The user may specify `--scope`:

- `global` (default) → directory: `data/skills`
- `main` → directory: `data/agents/main/skills`
- `project=<name>` → directory: `data/agents/projects/<name>/skills`

If no scope is specified, use `global`.

Create the target directory if it does not exist before running clawhub commands.

## Commands

### search \<query\>

```bash
clawhub search "<query>"
```

Present the results to the user in a readable format.

### install \<slug\> [--scope \<scope\>] [--version X.Y.Z]

Resolve the target directory from scope, then:

```bash
mkdir -p <target-dir>
clawhub install <slug> --workdir . --dir <target-dir> [--version X.Y.Z]
```

After success, confirm which skill was installed, where, and that it is now available.

### update [--all | \<slug\>] [--scope \<scope\>]

Resolve the target directory from scope, then:

```bash
clawhub update <slug> --workdir . --dir <target-dir>
# or for all:
clawhub update --all --workdir . --dir <target-dir> --no-input
```

### list [--scope \<scope\>]

List installed skills. If scope is specified, list from that directory. Otherwise list global:

```bash
clawhub list --workdir . --dir <target-dir>
```

Also show the user which local skill directories exist and how many skills each contains.

### remove \<slug\> [--scope \<scope\>]

Resolve the target directory from scope, then remove the skill directory:

```bash
rm -rf <target-dir>/<slug>
```

If `.clawhub/lock.json` exists in the workdir, note that the lock file may need manual cleanup.

## Notes

- Default registry: https://clawhub.com (override with CLAWHUB_REGISTRY env var)
- Skills are auto-detected by Pegasus after install/update/remove — no restart needed
- Use `clawhub login` for publishing (not covered by this skill)
