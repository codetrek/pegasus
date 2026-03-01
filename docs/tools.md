# Tools System

> Source: `src/tools/`

## Core Idea

Tools are the sole channel through which an Agent interacts with the outside world. Like human hands, tools enable the Agent to:
- Read and write files
- Make network requests
- Perform system operations
- Call external APIs
- Access long-term memory

The tool system follows these design principles:

| Principle | Description |
|-----------|-------------|
| **Unified Interface** | All tools (built-in, MCP, custom) share the same `Tool` interface |
| **Type Safety** | Parameters are validated with Zod schemas |
| **Async Execution** | Tools execute asynchronously without blocking the Agent; results flow through events |
| **Observability** | Every tool call produces events, providing a fully traceable history |
| **Extensibility** | New tools can be registered dynamically at runtime |
| **Controlled Concurrency** | Tool calls are gated by a semaphore to limit parallelism |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent (Actor)                          │
│                  Cognitive Stage — ACTING                   │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                     ToolRegistry                            │
│  ┌─────────────────┐ ┌─────────────────┐ ┌──────────────┐ │
│  │  Built-in Tools │ │   MCP Client    │ │ Custom Tools  │ │
│  └─────────────────┘ └─────────────────┘ └──────────────┘ │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    ToolExecutor                              │
│              - Parameter validation (Zod)                    │
│              - Timeout protection                            │
│              - Error handling                                │
│              - Completion event emission                     │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
                    ┌────────────────┐
                    │ Concrete Tool  │
                    │ (Tool iface)   │
                    └────────────────┘
```

---

## Core Types

### Tool (interface)

```typescript
interface Tool {
  name: string;                      // Unique identifier
  description: string;               // Description shown to the LLM
  category: ToolCategory;            // Category tag
  parameters: z.ZodTypeAny;          // Zod schema for parameter validation
  execute: (params: unknown, context: ToolContext) => Promise<ToolResult>;
}

enum ToolCategory {
  SYSTEM  = "system",    // System utilities (time, env vars)
  FILE    = "file",      // File operations
  NETWORK = "network",   // HTTP requests, web search
  DATA    = "data",      // JSON, base64, etc.
  MEMORY  = "memory",    // Long-term memory read/write
  CODE    = "code",      // (future) Code execution
  MCP     = "mcp",       // (future) MCP external tools
  CUSTOM  = "custom",    // (future) User-defined tools
}
```

### ToolResult

```typescript
interface ToolResult {
  success: boolean;
  result?: unknown;        // Return value on success
  error?: string;          // Error message on failure
  startedAt: number;       // Unix ms
  completedAt?: number;    // Unix ms
  durationMs?: number;     // Execution duration
}
```

### ToolContext

```typescript
interface ToolContext {
  taskId: string;            // Associated task ID
  userId?: string;           // User ID (for access control)
  allowedPaths?: string[];   // Whitelist for file operations
  memoryDir?: string;        // Root directory for memory tools
  sessionDir?: string;       // Session directory for session tools
}
```

---

## ToolRegistry

```typescript
class ToolRegistry {
  register(tool: Tool): void;                       // Register a single tool (throws if duplicate)
  registerMany(tools: Tool[]): void;                // Bulk register
  get(name: string): Tool | undefined;              // Look up by name
  has(name: string): boolean;                       // Existence check
  list(): Tool[];                                   // All registered tools
  listByCategory(category: ToolCategory): Tool[];   // Filter by category
  toLLMTools(): ToolDefinition[];                    // Convert to LLM function-calling format
  getStats(): ToolStats;                            // Usage statistics
  updateCallStats(name: string, duration: number, success: boolean): void;
}

interface ToolStats {
  total: number;
  byCategory: Record<ToolCategory, number>;
  callStats: Record<string, { count: number; failures: number; avgDuration: number }>;
}
```

---

## Built-in Tool Catalogue

### System Tools (SYSTEM)

| Tool | Description | Parameters | Return |
|------|-------------|------------|--------|
| `current_time` | Get the current time | `{ timezone?: string }` | `{ timestamp, iso, timezone }` |
| `sleep` | Delay execution | `{ duration: number }` (seconds) | `{ slept: number }` |
| `get_env` | Read an environment variable | `{ key: string }` | `{ value: string \| null }` |
| `set_env` | Set an environment variable | `{ key: string, value: string }` | `{ previous: string \| null }` |

### File Tools (FILE)

| Tool | Description | Parameters | Return |
|------|-------------|------------|--------|
| `read_file` | Read file content | `{ path, encoding?, offset?, limit? }` | `{ content, size, totalLines }` |
| `write_file` | Write/overwrite a file | `{ path, content, encoding? }` | `{ bytesWritten }` |
| `list_files` | List directory entries | `{ path, recursive?, pattern? }` | `{ files: FileInfo[] }` |
| `delete_file` | Delete a file | `{ path }` | `{ deleted: boolean }` |
| `move_file` | Move or rename a file | `{ from, to }` | `{ success: boolean }` |
| `get_file_info` | File metadata | `{ path }` | `{ exists, size, modified }` |
| `edit_file` | Apply targeted edits to a file | `{ path, edits }` | `{ applied }` |
| `grep_files` | Search file contents by pattern | `{ pattern, path?, ... }` | `{ matches }` |

### Network Tools (NETWORK)

| Tool | Description | Parameters | Return |
|------|-------------|------------|--------|
| `http_get` | HTTP GET | `{ url, headers? }` | `{ status, headers, body }` |
| `http_post` | HTTP POST | `{ url, body?, headers? }` | `{ status, headers, body }` |
| `http_request` | Generic HTTP request | `{ method, url, body?, headers? }` | `{ status, headers, body }` |
| `web_search` | Web search | `{ query, limit? }` | `{ results: SearchResult[] }` |

### Data Tools (DATA)

| Tool | Description | Parameters | Return |
|------|-------------|------------|--------|
| `json_parse` | Parse JSON string | `{ text }` | `{ data: unknown }` |
| `json_stringify` | Serialize to JSON | `{ data, pretty? }` | `{ text }` |
| `base64_encode` | Base64 encode | `{ text }` | `{ encoded }` |
| `base64_decode` | Base64 decode | `{ encoded }` | `{ decoded }` |

### Memory Tools (MEMORY)

Memory tools operate on markdown files stored under `data/memory/` (facts and episodes). Each file may contain a `> Summary: ...` line used as an index entry.

| Tool | Description | Parameters | Return |
|------|-------------|------------|--------|
| `memory_list` | List memory files with summaries | `{}` | `[{ path, summary, size }]` |
| `memory_read` | Read a memory file | `{ path }` | `string` (file content) |
| `memory_write` | Write or overwrite a memory file | `{ path, content }` | `{ path, size }` |
| `memory_patch` | Partial string replacement in a memory file | `{ path, old_str, new_str }` | `{ path, size }` |
| `memory_append` | Append an entry to a memory file | `{ path, entry, summary? }` | `{ path, size }` |

**`memory_patch`** finds exactly one occurrence of `old_str` in the file and replaces it with `new_str`. Fails if the string is not found or appears multiple times (provide more surrounding context to disambiguate).

**`memory_append`** appends `entry` to the end of the file. If the optional `summary` parameter is provided, it also updates (or inserts) the file-level `> Summary:` line.

### Task Tools (DATA)

| Tool | Description | Parameters | Return |
|------|-------------|------------|--------|
| `task_list` | List historical tasks for a date | `{ date?, dataDir? }` | task index entries |
| `task_replay` | Replay a task's conversation | `{ taskId, dataDir? }` | replayed messages |

### Session Tools (SYSTEM)

| Tool | Description | Parameters | Return |
|------|-------------|------------|--------|
| `session_archive_read` | Read a previous archived session file | `{ file }` | session content |

### Main Agent–Only Tools (SYSTEM)

| Tool | Description | Parameters |
|------|-------------|------------|
| `spawn_task` | Launch a background task | `{ description, input }` |
| `reply` | Speak to the user (the **only** way to produce user-visible output) | `{ text, channelId, replyTo? }` |
| `use_skill` | Invoke a skill by name | `{ skill, args? }` |

### Task Agent–Only Tools (SYSTEM)

| Tool | Description | Parameters |
|------|-------------|------------|
| `notify` | Send a message to the main agent during task execution | `{ message }` |

The `notify` tool is a general-purpose communication channel from Task Agent to MainAgent. Use cases include progress updates, interim results, clarification requests, and warnings. Each notify call emits a `TASK_NOTIFY` event (persisted to JSONL) and calls the `notifyCallback` so MainAgent can react.

---

## Tool Collections

Different subsystems receive different tool subsets via pre-built arrays:

| Collection | Contents | Used By |
|------------|----------|---------|
| `allTaskTools` | systemTools + fileTools + networkTools + dataTools + memoryTools + taskTools + `notify` | Task System — `general` type (default) |
| `exploreTools` | Read-only subset: `current_time`, `get_env`, `read_file`, `list_files`, `get_file_info`, `grep_files`, `http_get`, `web_search`, `json_parse`, `base64_decode`, `memory_list`, `memory_read`, `task_list`, `task_replay`, `notify` | Task System — `explore` type |
| `planTools` | exploreTools + `memory_write`, `memory_append` | Task System — `plan` type |
| `mainAgentTools` | `current_time`, `memory_list`, `memory_read`, `memory_write`, `memory_patch`, `memory_append`, `task_list`, `task_replay`, `session_archive_read`, `spawn_task`, `resume_task`, `reply`, `use_skill` | Main Agent |
| `reflectionTools` | `memory_read`, `memory_write`, `memory_patch`, `memory_append` | PostTaskReflector |
| `sessionTools` | `session_archive_read` | Session layer |

**Key design decisions:**

- **`allTaskTools`** does **not** include `spawn_task`, `reply`, or `use_skill` — those are Main Agent–only. It **does** include `notify` for task → main agent communication.
- **`exploreTools`** is a strict read-only subset — no file write, no HTTP POST, no memory write. Designed for safe research tasks.
- **`planTools`** extends explore with memory write access so plans can be persisted, but still cannot modify code files.
- **`getToolsForType(taskType)`** returns the correct tool array for a given task type (`"general"` → `allTaskTools`, `"explore"` → `exploreTools`, `"plan"` → `planTools`).
- **`mainAgentTools`** gives the orchestrator read-only access to memory and task history, plus the ability to spawn tasks, invoke skills, and reply.
- **`reflectionTools`** provides full memory write access but omits `memory_list` because the memory index is pre-loaded and injected into the reflection prompt.

---

## Tool Execution Flow

```
1. ACTING phase
   Actor executes a PlanStep where actionType = "tool_call"

2. Look up tool
   ToolRegistry.get(toolName)

3. Validate parameters
   tool.parameters.parse(params)   → throws ToolValidationError on failure

4. Execute with timeout
   await tool.execute(validatedParams, context)
   Protected by Promise.race against a timeout timer

5. Update call statistics
   registry.updateCallStats(toolName, durationMs, success)

6. Caller emits completion event
   executor.emitCompletion(toolName, result, context)
   → TOOL_CALL_COMPLETED or TOOL_CALL_FAILED

7. Record to TaskContext
   task.context.actionsDone.push(actionResult)
```

> **Note:** The ToolExecutor emits `TOOL_CALL_REQUESTED` immediately at the start but does **not** emit the completion event itself. The caller must call `emitCompletion()` after updating dependent state (actionsDone, markStepDone). This avoids a race condition where the EventBus processes the completion event before the caller has finished updating context.

---

## Event Integration

Tool calls communicate with the rest of the system through events:

| Event Type | Trigger | Payload |
|------------|---------|---------|
| `TOOL_CALL_REQUESTED` (400) | Tool execution begins | `{ toolName, params }` |
| `TOOL_CALL_COMPLETED` (410) | Tool execution succeeds | `{ toolName, result, durationMs }` |
| `TOOL_CALL_FAILED` (420) | Tool execution fails | `{ toolName, error }` |

Event flow example:

```
ACTING state
  ↓ Actor.runStep()
TOOL_CALL_REQUESTED { toolName: "web_search", params: { query: "AI Agent" } }
  ↓ ToolExecutor.execute()
  ↓ Actual tool execution (may involve network I/O)
  ↓ Caller updates context
TOOL_CALL_COMPLETED { toolName: "web_search", result: { results: [...] } }
  ↓ Record result
ActionResult appended to TaskContext.actionsDone
```

---

## PostTaskReflection

After a task completes, the `PostTaskReflector` uses `reflectionTools` to consolidate learnings into long-term memory. It returns:

```typescript
interface PostTaskReflection {
  assessment: string;      // Free-form assessment of the task
  toolCallsCount: number;  // Number of tool calls the reflector made
}
```

The reflector receives the full task context plus pre-loaded memory (existing facts and episode index) and autonomously decides what to write, patch, or append to memory files.

---

## Security and Permissions

### File Access Restriction

```typescript
// File tools check ToolContext.allowedPaths before execution
const context: ToolContext = {
  taskId: "abc123",
  allowedPaths: [
    "/workspace/pegasus/data",
    "/workspace/pegasus/docs",
  ],
};

// Path check — subdirectories are automatically included
if (!isPathAllowed(path, context.allowedPaths)) {
  throw new ToolPermissionError(toolName, "Path not in allowed paths");
}
```

### Memory Path Security

Memory tools use `resolveMemoryPath()` to prevent directory traversal. All paths are resolved against `memoryDir` and must remain within it:

```typescript
function resolveMemoryPath(relativePath: string, memoryDir: string): string {
  const resolved = path.resolve(memoryDir, relativePath);
  if (!resolved.startsWith(memoryRoot + "/") && resolved !== memoryRoot) {
    throw new Error(`Path "${relativePath}" escapes memory directory`);
  }
  return resolved;
}
```

### Timeout Protection

```typescript
// Default tool execution timeout
const DEFAULT_TOOL_TIMEOUT = 30000; // 30 seconds

// ToolExecutor uses Promise.race to enforce the timeout
const result = await Promise.race([
  tool.execute(params, context),
  timeoutPromise,  // rejects with ToolTimeoutError
]);
```

### Concurrency Control

```typescript
// The Agent's toolSemaphore limits the number of tools executing simultaneously
this.toolSemaphore = new Semaphore(
  this.settings.agent.maxConcurrentTools // default: 3
);
```

---

## Error Handling

### Error Types

```typescript
class ToolError extends Error {
  constructor(public toolName: string, message: string, public cause?: unknown);
}

class ToolNotFoundError extends ToolError {
  // `Tool "${toolName}" not found`
}

class ToolValidationError extends ToolError {
  // "Parameter validation failed" — cause contains Zod issues
}

class ToolTimeoutError extends ToolError {
  // `Tool execution timed out after ${timeout}ms`
}

class ToolPermissionError extends ToolError {
  // `Permission denied: ${message}`
}
```

### Error Recovery Strategy

When a tool fails, the Reflector evaluates the situation and decides:

```typescript
interface Reflection {
  verdict: "complete" | "continue" | "replan";
  assessment: string;
  lessons: string[];
  nextFocus?: string;
}
```

- **`continue`** — Ignore the error and proceed to the next step
- **`replan`** — Revise the plan, possibly using an alternative tool
- **`complete`** — Treat the task as finished despite the error (partial success)

---

## MCP Integration

MCP (Model Context Protocol) tools integrate as external tools through the standard `Tool` interface. Pegasus connects to MCP servers, discovers their tools, and registers them alongside built-in tools — making them indistinguishable at runtime.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  MainAgent                                          │
│  ├── MCPManager (owns lifecycle)                    │
│  │   ├── Client("filesystem") ── StdioTransport     │
│  │   └── Client("remote")     ── SSE/HTTPTransport  │
│  ├── ToolRegistry (MCP + built-in tools)            │
│  └── Agent                                          │
│      └── ToolRegistry (MCP + built-in tools)        │
└─────────────────────────────────────────────────────┘
```

### Components

**`MCPManager`** (`src/mcp/manager.ts`) — Connection lifecycle for MCP servers.

- `connectAll(configs)` — Connect to all enabled servers (graceful degradation on failure)
- `disconnectAll()` — Clean up all connections
- `listTools(serverName)` — Discover tools from a connected server
- `callTool(serverName, toolName, args)` — Execute a tool on a connected server
- Supports **stdio** (local subprocess via `StdioClientTransport`) and **SSE/StreamableHTTP** (remote server with automatic fallback)

**`wrapMCPTools()`** (`src/mcp/wrap.ts`) — Converts MCP tools to Pegasus `Tool` objects.

- **Naming**: `{serverName}__{toolName}` (double underscore avoids collisions across servers)
- **Description**: `[{serverName}] {original description}` (prefix helps LLM identify source)
- **Category**: `ToolCategory.MCP`
- **Parameters**: `z.any()` (MCP server handles validation, not Pegasus)
- **parametersJsonSchema**: Raw JSON Schema from MCP `inputSchema` — used directly in `toLLMTools()` to bypass Zod→JSON Schema conversion
- **execute()**: Delegates to `MCPManager.callTool()`, converts `CallToolResult` → `ToolResult`

### Configuration

```yaml
tools:
  mcpServers:
    # stdio transport (local subprocess)
    - name: filesystem
      transport: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
      env: {}
      cwd: .
      enabled: true

    # SSE/HTTP transport (remote server)
    - name: remote-tools
      transport: sse
      url: http://localhost:3000/sse
      enabled: true
```

### Lifecycle

1. **MainAgent.start()** creates `MCPManager`, calls `connectAll()`
2. `loadMCPTools()` registers wrapped MCP tools in Agent's `ToolRegistry`
3. MainAgent also registers MCP tools in its own `ToolRegistry`
4. MCP tools participate in LLM function calling like built-in tools
5. **MainAgent.stop()** calls `MCPManager.disconnectAll()` before stopping Agent

### Error Handling

- **Connection failure**: Logged as warning, server skipped (graceful degradation)
- **Tool call failure**: Returns `ToolResult { success: false, error: ... }` (same as built-in tool errors)
- **Transport fallback**: SSE transport tries StreamableHTTP first, falls back to SSE on failure

---

## Extending with Custom Tools

Create a custom tool by implementing the `Tool` interface:

```typescript
import { z } from "zod";
import type { Tool, ToolResult, ToolContext } from "./types";

const myCustomTool: Tool = {
  name: "my_custom_tool",
  description: "Description of what this tool does",
  category: ToolCategory.CUSTOM,
  parameters: z.object({
    input: z.string(),
    optional: z.number().optional(),
  }),

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { input, optional } = params as { input: string; optional?: number };
    const startedAt = Date.now();

    try {
      const result = await doSomething(input, optional);
      return {
        success: true,
        result,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// Register it
const registry = new ToolRegistry();
registry.register(myCustomTool);
```

---

## Configuration

Tool behavior is controlled through the config file:

```yaml
# config.yml
tools:
  timeout: 30000        # Tool call timeout (ms)
  maxConcurrent: 3      # Max parallel tool executions

  allowedPaths:          # File access whitelist
    - "./data"
    - "./docs"
    - "./src"

  webSearch:
    provider: "tavily"   # "tavily" | "google" | "bing" | "duckduckgo"
    apiKey: "${WEB_SEARCH_API_KEY}"
    maxResults: 10

  mcpServers:
    # stdio transport — runs a local MCP server as a subprocess
    - name: "filesystem"
      transport: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
      enabled: true

    # sse transport — connects to a remote MCP server via SSE/StreamableHTTP
    - name: "remote"
      transport: sse
      url: "http://localhost:3000/sse"
      enabled: false
```

---

## Testing

Tool testing strategy:

```typescript
import { describe, it, expect } from "bun:test";
import { read_file } from "./file-tools";

describe("read_file", () => {
  it("should read file content", async () => {
    const result = await read_file.execute(
      { path: "/tmp/test.txt" },
      { taskId: "test" },
    );

    expect(result.success).toBe(true);
    expect(result.result).toHaveProperty("content");
  });

  it("should fail on non-existent file", async () => {
    const result = await read_file.execute(
      { path: "/tmp/nonexistent.txt" },
      { taskId: "test" },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("should reject unauthorized paths", async () => {
    const result = await read_file.execute(
      { path: "/etc/passwd" },
      { taskId: "test", allowedPaths: ["/tmp"] },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Permission denied");
  });
});
```

---

## Performance Considerations

| Concern | Strategy |
|---------|----------|
| Concurrency | Semaphore limits parallel tool calls to prevent resource exhaustion |
| Timeout | Each tool has a configurable timeout to prevent indefinite blocking |
| Caching | Read-only operations (e.g., file reads) can leverage in-memory caching |
| Batch Operations | Bulk operations supported (e.g., `list_files` with recursive mode) |
| Resource Cleanup | Network connections and file handles are properly released |

---

## Future Extensions

1. **Streaming Tools** — Support streaming output (e.g., real-time log tailing)
2. **Tool Chains** — Compose tools into pipelines
3. **Tool Dependencies** — Declare inter-tool dependencies with automatic execution ordering
4. **Tool Versioning** — Support multiple versions of the same tool
5. **Audit Logging** — Detailed tool call audit trail
6. **A/B Testing** — Compare alternative tool implementations
