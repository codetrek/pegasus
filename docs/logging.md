# Logging

## Overview

Pegasus has a built-in logging system with automatic file output, log rotation, and cleanup. **File logging is always enabled** and cannot be disabled.

## Features

### 1. Automatic File Logging

- **Always Enabled**: Logs are always written to `{homeDir}/logs/pegasus.log`
- **Cannot be Disabled**: File logging is a core feature and always active

### 2. Configurable Log Format

- **JSON** (default): Structured JSON lines, machine-parseable
- **Line**: Human-readable single-line format with timestamp, level, module, message, and key=value pairs
- **Global Setting**: Applies to file output

### 3. Automatic Log Rotation

- **Daily Rotation**: Creates new log file daily at midnight
- **Size-Based Rotation**: Rotates when file exceeds 10MB
- **File Naming**: `pegasus.log.YYYY-MM-DD`
- **Auto Cleanup**: Retains logs for 30 days, automatically deletes older logs

### 4. Zero Configuration

- Automatically creates log directory
- No configuration needed for file logging
- Works out of the box

## Quick Start

### Default Behavior

By default, Pegasus:
- ✅ **Always** writes logs to file (`data/logs/pegasus.log`)
- Logs only go to file — no console output

### View Logs

**Using standard Unix tools**:
```bash
# Tail log file
tail -f data/logs/pegasus.log

# View last 100 lines
tail -100 data/logs/pegasus.log

# Search for specific keyword
grep "error" data/logs/pegasus.log

# Pretty-print JSON logs
cat data/logs/pegasus.log | jq '.'
```

## Configuration

### Basic Configuration

```yaml
system:
  # Log level: debug | info | warn | error | silent
  logLevel: info

  # Log output format: json | line (default: json)
  logFormat: json
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PEGASUS_LOG_LEVEL` | Log level | `info` |
| `PEGASUS_HOME_DIR` | Home directory (logs at `{homeDir}/logs/`) | `~/.pegasus` |
| `PEGASUS_LOG_FORMAT` | Log output format: `json` or `line` | `json` |

**Note**:
- Log file path is always `{PEGASUS_HOME_DIR}/logs/pegasus.log`
- File logging cannot be disabled
- `logFormat` controls **how** logs are formatted (format)

## Use Cases

### Scenario 1: Development (File Only)

```yaml
system:
  logLevel: debug
  # Logs written to {homeDir}/logs/pegasus.log
  # No console output
```

### Scenario 2: Development (Human-Readable Logs)

```yaml
system:
  logLevel: debug
  logFormat: line  # Human-readable single-line format
```

### Scenario 3: Production

```yaml
system:
  logLevel: info
  homeDir: /var/lib/pegasus
  logFormat: json           # Structured JSON for log aggregation
  # Logs written to /var/lib/pegasus/logs/pegasus.log
```

### Scenario 4: Performance Testing

```yaml
system:
  logLevel: silent  # Minimize logging overhead
  # Still writes to file, but only critical errors
```

## Log Format

The `logFormat` setting controls how logs are formatted in the log file.

### JSON Format (`logFormat: json`, default)

Structured JSON lines, ideal for machine parsing and log aggregation:

```json
{"level":"info","time":"2026-02-24T10:00:00.000Z","module":"config_loader","msg":"loading_base_config","path":"config.yml"}
```

**Field Explanations:**
- `level`: Log level as string label (info, warn, error, etc.)
- `time`: ISO 8601 timestamp
- `module`: Logger namespace
- `msg`: Log message
- Additional fields: Custom data attached to the log entry

### Line Format (`logFormat: line`)

Human-readable single-line format, ideal for development and quick debugging:

```
2026-02-24T10:00:00.000Z INFO  [config_loader] loading_base_config path=config.yml
```

### Viewing JSON Logs in Human-Readable Format

When using `logFormat: json` (default), use `jq` or switch to `line` format to view logs:

```bash
$ tail -f data/logs/pegasus.log
{"level":"info","time":"2026-02-24T10:00:00.000Z","module":"config_loader","msg":"loading_base_config","path":"config.yml"}

# Or use jq for pretty-printed JSON
$ tail -f data/logs/pegasus.log | jq '.'
```

## Log Rotation

### Automatic Rotation Rules

1. **Daily Rotation**
   - Time: Midnight (00:00) daily
   - Naming: `pegasus.log.2024-02-12`

2. **Size-Based Rotation**
   - Trigger: File exceeds 10MB
   - Action: Creates new file and continues writing

3. **Automatic Cleanup**
   - Retention Period: 30 days
   - Mechanism: Automatically deletes logs older than 30 days on startup
   - Trigger: Executed on each application startup or config reload

### Log File Examples

```
data/logs/
├── pegasus.log              # Current log file
├── pegasus.log.2024-02-12   # Yesterday's log
├── pegasus.log.2024-02-11   # Two days ago
└── pegasus.log.2024-02-10   # Three days ago
```

## Log Cleanup

### Automatic Cleanup (Built-in)

The system automatically deletes logs older than 30 days on startup. No manual intervention required.

### Manual Cleanup (Optional)

For immediate cleanup or custom retention policy:

```bash
# Delete logs older than 7 days
find data/logs/ -name "pegasus.log.*" -mtime +7 -delete

# Keep only last 10 log files
cd data/logs && ls -t pegasus.log.* | tail -n +11 | xargs rm -f
```

## Troubleshooting

### Cannot Disable File Logging

**Q: How do I disable file logging?**

A: File logging cannot be disabled. It is a core feature of Pegasus that ensures all operations are logged for debugging and audit purposes.

If disk space is a concern:
1. Use `silent` log level to minimize output
2. Reduce data directory to a mounted volume with sufficient space
3. Adjust manual cleanup to be more aggressive

### No Console Output

Logs only go to file. To view logs in real-time, use:
- `tail -f data/logs/pegasus.log`
- For human-readable format, set `logFormat: line`

### Log File Too Large

Solutions:
1. Lower log level (info → warn → error)
2. Log rotation is already enabled by default (10MB threshold)
3. Automatic cleanup retains only 30 days

### Performance Impact

If concerned about logging performance:
1. Use `warn` or `error` level to reduce log volume
2. File logging uses efficient buffered writes
3. Use `silent` level for performance testing (minimal logging)

## Best Practices

1. **Development**
   - Use `debug` level for detailed logs
   - Use `line` format for human-readable output
   - Use `tail -f` to follow log file in real-time

2. **Testing**
   - Use `info` level
   - File logs available for post-mortem analysis

3. **Production**
   - Use `info` or `warn` level
   - Use `json` format for log aggregation
   - Configure log aggregation system to collect from file
   - Monitor disk space for log directory

4. **Log Analysis**
   - Use `jq` to parse JSON logs
   - Integrate with ELK/Loki log platforms via file tailing
   - Configure alerting rules on log patterns
   - Leverage structured JSON format for queries

## Design Rationale

### Why Two Log Formats?

The `logFormat` setting provides flexibility for different environments:

| Format | Use Case |
|--------|----------|
| `json` (default) | Production — machine-parseable, ideal for log aggregation |
| `line` | Development — human-readable single-line format for quick debugging |

### Why Always-On File Logging?

1. **Reliability**: Ensures all operations are logged
2. **Debugging**: Complete audit trail for troubleshooting
3. **Simplicity**: No configuration needed
4. **Safety**: Prevents accidental loss of important logs

## References

- [Pino Documentation](https://getpino.io/)
- [Pino-roll Documentation](https://github.com/feugy/pino-roll)
- [Configuration Guide](./configuration.md)
