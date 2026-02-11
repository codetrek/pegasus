# GitHub Actions CI Configuration

This directory contains the GitHub Actions workflows for the Pegasus project.

## Workflows Overview

### 1. **test.yml** (Reusable Workflow)
A reusable workflow that runs tests and checks coverage. This is the core testing workflow that PR workflow calls.

**Features:**
- Runs type checking with TypeScript
- Executes all unit and integration tests
- Calculates line coverage percentage
- Enforces configurable coverage threshold
- Uploads coverage reports as artifacts

**Inputs:**
- `coverage-threshold` (number, default: 0): Minimum line coverage percentage required to pass

**Outputs:**
- `coverage` (string): Actual coverage percentage achieved

### 2. **pr.yml** (Pull Request to Main)
Runs on pull requests targeting the `main` branch with **strict requirements**.

**Requirements:**
- ✅ All tests must pass
- ✅ Type checking must pass
- ✅ **Line coverage must be ≥ 95%** ⚠️

**Trigger:**
```yaml
pull_request:
  branches: [main]
  paths-ignore: [**.md, docs/**, .gitignore, LICENSE]
```

**Note:** Push to main/develop does not trigger CI, as tests are expected to be run locally before pushing.

## Architecture Decision: Reusable Workflow

### Why Reusable Workflow?

We use GitHub's [reusable workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows) pattern for modularity and future extensibility:

```
test.yml (reusable core)
    ↑
    │
  pr.yml
(95% threshold)
```

**Benefits:**
1. **DRY Principle**: Test logic defined once, can be reused in multiple contexts
2. **Maintainability**: Update test steps in one place
3. **Flexibility**: Different thresholds for different contexts
4. **Scalability**: Easy to add new triggers in the future (e.g., scheduled runs, release workflows)

**Design Decision**: Push to main/develop does not trigger CI, as tests are expected to be run locally before pushing (via git hooks or manual `bun run check`). This reduces CI overhead while the PR check ensures quality control before merging.

### Example: Adding a New Workflow

To create a workflow for scheduled nightly tests:

```yaml
# .github/workflows/nightly.yml
name: Nightly Tests

on:
  schedule:
    - cron: '0 2 * * *'  # Run at 2 AM UTC daily

jobs:
  test:
    uses: ./.github/workflows/test.yml
    with:
      coverage-threshold: 98  # Higher standard for nightly checks
```

## Coverage Threshold Rationale

| Context | Threshold | Rationale |
|---------|-----------|-----------|
| **PR to main** | **95%** | Ensures new code maintains high quality standards before merging |
| Push to main/develop | N/A | No CI on push - tests run locally via git hooks or manual check |
| **Current coverage** | **99.90%** | Project already exceeds requirements ✅ |

## Local Development

Run the same checks locally before pushing:

```bash
# Run all checks (typecheck + test)
bun run check

# Run tests with coverage report
bun run coverage

# Or use Makefile
make check
make coverage
```

## Troubleshooting

### Coverage Below Threshold

If your PR fails with coverage below 95%:

1. Check which files have low coverage:
   ```bash
   bun run coverage
   ```

2. Look for "Uncovered Line #s" in the report

3. Add tests for uncovered lines

4. Re-run coverage to verify:
   ```bash
   bun run coverage
   ```

### Workflow Syntax Errors

To validate workflow files locally:

```bash
# Install actionlint
brew install actionlint  # macOS
# or download from https://github.com/rhysd/actionlint

# Validate workflows
actionlint .github/workflows/*.yml
```

## Future Enhancements

Potential improvements to consider:

- [ ] Add code coverage comments on PRs
- [ ] Integrate with Codecov or Coveralls for visual reports
- [ ] Add performance benchmarks
- [ ] Add security scanning (Dependabot, CodeQL)
- [ ] Add linting checks (biome/eslint)
- [ ] Matrix testing across multiple Bun versions
- [ ] Automated dependency updates

## References

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Reusable Workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows)
- [Bun Test Coverage](https://bun.sh/docs/cli/test#coverage)
