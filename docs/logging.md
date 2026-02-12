# Logging

## Overview

Pegasus has a built-in logging system with automatic file output, log rotation, and cleanup. **File logging is always enabled** and cannot be disabled.

## Features

### 1. Automatic File Logging

- **Always Enabled**: Logs are always written to `{dataDir}/logs/pegasus.log`
- **JSON Format**: File logs use JSON format for easy parsing
- **Cannot be Disabled**: File logging is a core feature and always active

### 2. Optional Console Output

- **Disabled by Default**: Console output must be explicitly enabled
- **Development**: Colorized format (pino-pretty)
- **Production**: JSON format to stdout
- **Use Case**: Primarily for debugging and development

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
- ❌ Does not output logs to console

### Enable Console Output

To view logs in console (e.g., during debugging):

**Method 1: Configuration File**

Edit `config.yml` or `config.local.yml`:

```yaml
system:
  logLevel: info
  dataDir: data
  logConsoleEnabled: true   # Enable console output
```

**Method 2: Environment Variable**

```bash
export PEGASUS_LOG_CONSOLE_ENABLED=true
bun run dev
```

**Method 3: Temporary Enable**

```bash
PEGASUS_LOG_CONSOLE_ENABLED=true bun run dev
```

### View Logs

**Using pino-pretty (Recommended)**:
```bash
# View logs with human-readable format
bun logs

# View all historical logs
bun logs:all

# Or use pino-pretty directly
tail -f data/logs/pegasus.log | pino-pretty
cat data/logs/pegasus.log | pino-pretty
```

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

  # Data directory (logs saved to {dataDir}/logs/pegasus.log)
  dataDir: data

  # Enable console logging (default: false)
  logConsoleEnabled: false
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PEGASUS_LOG_LEVEL` | Log level | `info` |
| `PEGASUS_DATA_DIR` | Data directory | `data` |
| `PEGASUS_LOG_CONSOLE_ENABLED` | Enable console logging | `false` |

**Note**:
- Log file path is always `{PEGASUS_DATA_DIR}/logs/pegasus.log`
- File logging cannot be disabled

## Use Cases

### Scenario 1: Development (File Only)

```yaml
system:
  logLevel: debug
  dataDir: data
  # Logs written to data/logs/pegasus.log
  # No console output
```

### Scenario 2: Development (With Console)

```yaml
system:
  logLevel: debug
  dataDir: data
  logConsoleEnabled: true  # Also output to console for debugging
```

### Scenario 3: Production

```yaml
system:
  logLevel: info
  dataDir: /var/lib/pegasus
  logConsoleEnabled: false  # No console output in production
  # Logs written to /var/lib/pegasus/logs/pegasus.log
```

### Scenario 4: Performance Testing

```yaml
system:
  logLevel: silent  # Minimize logging overhead
  dataDir: data
  # Still writes to file, but only critical errors
```

## Log Format

### Console Output (When Enabled)

**Development**:
```
[13:45:23.456] INFO (123): loading_base_config
    module: "config_loader"
    path: "config.yml"
```

**Production**:
```json
{"level":30,"time":1707734723456,"pid":123,"module":"config_loader","msg":"loading_base_config"}
```

**Note**: Console output is disabled by default. Set `logConsoleEnabled: true` to enable.

### File Output (Always Enabled)

File logs use JSON format for easy parsing by log aggregation systems:

```json
{
  "level": 30,
  "time": 1707734723456,
  "pid": 123,
  "hostname": "localhost",
  "module": "config_loader",
  "msg": "loading_base_config",
  "path": "config.yml"
}
```

**Field Explanations:**
- `level`: Log level as number (10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal)
- `time`: Unix timestamp in milliseconds (e.g., `1707734723456` = 2024-02-12 13:45:23.456 UTC)
- `pid`: Process ID
- `module`: Logger namespace
- `msg`: Log message
- Additional fields: Custom data attached to the log entry

**Human-Readable Viewing:**
Use `bun logs` or `pino-pretty` to convert to readable format:
```bash
$ bun logs
[2024-02-12 13:45:23.456] INFO (123): loading_base_config
    module: "config_loader"
    path: "config.yml"
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

If you don't see console logs:
- Check `logConsoleEnabled` is set to `true` (default: `false`)
- Temporarily enable: `PEGASUS_LOG_CONSOLE_ENABLED=true bun run dev`

### Log File Too Large

Solutions:
1. Lower log level (info → warn → error)
2. Log rotation is already enabled by default (10MB threshold)
3. Automatic cleanup retains only 30 days

### Performance Impact

If concerned about logging performance:
1. Use `warn` or `error` level to reduce log volume
2. Console output is disabled by default (no performance impact)
3. File logging uses efficient buffered writes
4. Use `silent` level for performance testing (minimal logging)

## Best Practices

1. **Development**
   - Use `debug` level for detailed logs
   - Enable console output for real-time feedback
   - File logs provide persistent record

2. **Testing**
   - Use `info` level
   - File logs available for post-mortem analysis
   - Optional console output for real-time monitoring

3. **Production**
   - Use `info` or `warn` level
   - File logging only (no console output)
   - Configure log aggregation system to collect from file
   - Monitor disk space for log directory

4. **Log Analysis**
   - Use `jq` to parse JSON logs
   - Integrate with ELK/Loki log platforms via file tailing
   - Configure alerting rules on log patterns
   - Leverage structured JSON format for queries

## Design Rationale

### Why Always-On File Logging?

1. **Reliability**: Ensures all operations are logged
2. **Debugging**: Complete audit trail for troubleshooting
3. **Simplicity**: No configuration needed
4. **Safety**: Prevents accidental loss of important logs

### Why Optional Console Output?

1. **Performance**: Console I/O is slower than file I/O
2. **Clarity**: Production logs should go to centralized systems
3. **Flexibility**: Enable when needed for development

## References

- [Pino Documentation](https://getpino.io/)
- [Pino-roll Documentation](https://github.com/feugy/pino-roll)
- [Configuration Guide](./configuration.md)
