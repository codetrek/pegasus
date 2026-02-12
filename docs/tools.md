# 工具系统 (Tools System)

> 对应代码：`src/tools/`

## 核心思想

工具是 Agent 与外部世界交互的唯一通道。就像人类的双手，工具让 Agent 能够：
- 读取和写入文件
- 发起网络请求
- 执行系统操作
- 调用外部 API
- 访问数据库

工具系统遵循以下设计原则：

| 原则 | 说明 |
|------|------|
| **统一接口** | 所有工具（内置、MCP、自定义）使用相同的接口 |
| **类型安全** | 使用 Zod schema 验证参数 |
| **异步执行** | 工具执行不阻塞 Agent，通过事件驱动 |
| **可观测** | 每个工具调用都产生事件，可追溯完整历史 |
| **可扩展** | 支持动态注册新工具 |
| **安全可控** | 工具调用受信号量控制，限制并发数 |

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                      Agent (Actor)                          │
│                   认知阶段 - ACTING                          │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                     ToolRegistry                            │
│  ┌─────────────────┐ ┌─────────────────┐ ┌──────────────┐ │
│  │  Built-in Tools │ │   MCP Client    │ │  Custom Tools│ │
│  │  (内置工具)      │ │  (外部工具)      │ │  (自定义工具) │ │
│  └─────────────────┘ └─────────────────┘ └──────────────┘ │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                    ToolExecutor                            │
│              - 参数验证 (Zod)                                │
│              - 超时控制                                      │
│              - 错误处理                                      │
│              - 结果封装                                      │
└────────────────────────────┬────────────────────────────────┘
                             │
                             ▼
                    ┌────────────────┐
                    │  具体工具实现   │
                    │  (Tool 接口)   │
                    └────────────────┘
```

---

## 核心类型定义

### Tool（工具接口）

```typescript
interface Tool {
  name: string;                      // 工具唯一标识
  description: string;               // 工具描述（给 LLM 看）
  category: ToolCategory;            // 工具分类
  parameters: z.ZodTypeAny;          // Zod schema 用于参数验证
  execute: (params: unknown, context: ToolContext) => Promise<ToolResult>;
}

enum ToolCategory {
  SYSTEM = "system",      // 系统工具（时间、环境变量等）
  FILE = "file",          // 文件操作
  NETWORK = "network",    // 网络请求
  DATA = "data",          // 数据处理
  CODE = "code",          // 代码执行
  MCP = "mcp",            // MCP 外部工具
  CUSTOM = "custom",      // 自定义工具
}
```

### ToolResult（工具执行结果）

```typescript
interface ToolResult {
  toolName: string;
  success: boolean;
  result?: unknown;        // 成功时的返回值
  error?: string;          // 失败时的错误信息
  startedAt: number;       // Unix ms
  completedAt?: number;    // Unix ms
  durationMs?: number;     // 执行耗时
}
```

### ToolContext（工具执行上下文）

```typescript
interface ToolContext {
  taskId: string;          // 关联的任务 ID
  userId?: string;         // 用户 ID（用于权限控制）
  allowedPaths?: string[];  // 允许访问的路径（文件操作限制）
  // 可扩展更多上下文信息
}
```

---

## ToolRegistry（工具注册表）

```typescript
class ToolRegistry {
  // 注册工具
  register(tool: Tool): void;

  // 批量注册
  registerMany(tools: Tool[]): void;

  // 获取工具
  get(name: string): Tool | undefined;

  // 检查工具是否存在
  has(name: string): boolean;

  // 列出所有工具
  list(): Tool[];

  // 按分类列出工具
  listByCategory(category: ToolCategory): Tool[];

  // 转换为 LLM 工具定义格式（用于函数调用）
  toLLMTools(): ToolDefinition[];

  // 获取工具统计信息
  getStats(): ToolStats;
}

interface ToolStats {
  total: number;
  byCategory: Record<ToolCategory, number>;
  callStats: Record<string, { count: number; failures: number; avgDuration: number }>;
}
```

---

## 内置工具列表

### 系统工具 (SYSTEM)

| 工具名 | 描述 | 参数 | 返回值 |
|--------|------|------|--------|
| `current_time` | 获取当前时间 | `{ timezone?: string }` | `{ timestamp: number, iso: string, timezone: string }` |
| `sleep` | 延时等待 | `{ duration: number }` (秒) | `{ slept: number }` |
| `get_env` | 获取环境变量 | `{ key: string }` | `{ value: string \| null }` |
| `set_env` | 设置环境变量 | `{ key: string, value: string }` | `{ previous: string \| null }` |

### 文件工具 (FILE)

| 工具名 | 描述 | 参数 | 返回值 |
|--------|------|------|--------|
| `read_file` | 读取文件内容 | `{ path: string, encoding?: string }` | `{ content: string, size: number }` |
| `write_file` | 写入文件 | `{ path: string, content: string, encoding?: string }` | `{ bytesWritten: number }` |
| `list_files` | 列出目录 | `{ path: string, recursive?: boolean, pattern?: string }` | `{ files: FileInfo[] }` |
| `delete_file` | 删除文件 | `{ path: string }` | `{ deleted: boolean }` |
| `move_file` | 移动/重命名文件 | `{ from: string, to: string }` | `{ success: boolean }` |
| `get_file_info` | 获取文件信息 | `{ path: string }` | `{ exists: boolean, size: number, modified: number }` |

### 网络工具 (NETWORK)

| 工具名 | 描述 | 参数 | 返回值 |
|--------|------|------|--------|
| `http_get` | HTTP GET 请求 | `{ url: string, headers?: Record<string, string> }` | `{ status: number, headers: Record<string, string>, body: string }` |
| `http_post` | HTTP POST 请求 | `{ url: string, body?: string, headers?: Record<string, string> }` | 同上 |
| `http_request` | 通用 HTTP 请求 | `{ method: string, url: string, body?: string, headers?: Record<string, string> }` | 同上 |
| `web_search` | 网络搜索 | `{ query: string, limit?: number }` | `{ results: SearchResult[] }` |

### 数据工具 (DATA)

| 工具名 | 描述 | 参数 | 返回值 |
|--------|------|------|--------|
| `json_parse` | 解析 JSON | `{ text: string }` | `{ data: unknown }` |
| `json_stringify` | 序列化 JSON | `{ data: unknown, pretty?: boolean }` | `{ text: string }` |
| `base64_encode` | Base64 编码 | `{ text: string }` | `{ encoded: string }` |
| `base64_decode` | Base64 解码 | `{ encoded: string }` | `{ decoded: string }` |

---

## 工具调用流程

```
1. ACTING 阶段
   Actor 执行 PlanStep，其中 actionType = "tool_call"

2. 查找工具
   ToolRegistry.get(toolName)

3. 参数验证
   tool.parameters.parse(params)

4. 工具执行
   await tool.execute(validatedParams, context)
   使用 toolSemaphore 控制并发

5. 结果封装
   ToolResult { success, result, error, durationMs }

6. 事件发布
   emit(TOOL_CALL_COMPLETED, { toolName, result })

7. 记录到 TaskContext
   task.context.actionsDone.push(actionResult)
```

---

## 事件集成

工具调用通过事件与系统其他部分通信：

| 事件类型 | 触发时机 | Payload |
|---------|---------|---------|
| `TOOL_CALL_REQUESTED` | 工具调用开始 | `{ toolName, params }` |
| `TOOL_CALL_COMPLETED` | 工具调用成功 | `{ toolName, result, durationMs }` |
| `TOOL_CALL_FAILED` | 工具调用失败 | `{ toolName, error, durationMs }` |

事件流示例：

```
ACTING 状态
  ↓ Actor.runStep()
TOOL_CALL_REQUESTED { toolName: "web_search", params: { query: "AI Agent" } }
  ↓ ToolExecutor.execute()
  ↓ 实际工具执行（可能有网络 I/O）
TOOL_CALL_COMPLETED { toolName: "web_search", result: { results: [...] } }
  ↓ 记录结果
ActionResult 记录到 TaskContext.actionsDone
```

---

## 安全与权限

### 文件访问限制

```typescript
// 通过 ToolContext.allowedPaths 限制文件操作
const context: ToolContext = {
  taskId: "abc123",
  allowedPaths: [
    "/workspace/pegasus/data",
    "/workspace/pegasus/docs",
  ],
};

// 文件工具在执行前检查路径
if (!isPathAllowed(path, context.allowedPaths)) {
  throw new ToolPermissionError("Access denied");
}
```

### 超时控制

```typescript
// 每个工具执行有默认超时，可配置
const DEFAULT_TOOL_TIMEOUT = 30000; // 30 秒

// 网络工具可能有更长的超时
const NETWORK_TOOL_TIMEOUT = 60000; // 60 秒
```

### 并发控制

```typescript
// Agent 中的 toolSemaphore 控制同时执行的工具数量
this.toolSemaphore = new Semaphore(
  this.settings.agent.maxConcurrentTools // 默认 3
);
```

---

## MCP 集成

MCP (Model Context Protocol) 是一种标准化工具协议。MCP 工具作为外部工具集成：

```typescript
interface MCPTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;  // JSON Schema 格式
}

class MCPClient {
  async connect(serverUrl: string): Promise<void>;
  async listTools(): Promise<MCPTool[]>;
  async callTool(name: string, args: unknown): Promise<unknown>;
  async disconnect(): Promise<void>;
}

// 将 MCP 工具包装为标准 Tool 接口
function wrapMCPTool(mcpTool: MCPTool, client: MCPClient): Tool {
  return {
    name: mcpTool.name,
    description: mcpTool.description,
    category: ToolCategory.MCP,
    parameters: jsonSchemaToZod(mcpTool.inputSchema),
    execute: async (params) => {
      return await client.callTool(mcpTool.name, params);
    },
  };
}
```

---

## 扩展自定义工具

创建自定义工具只需实现 Tool 接口：

```typescript
import { z } from "zod";
import type { Tool, ToolResult, ToolContext } from "./types";

// 1. 定义工具
const myCustomTool: Tool = {
  name: "my_custom_tool",
  description: "自定义工具描述",
  category: ToolCategory.CUSTOM,
  parameters: z.object({
    input: z.string(),
    optional: z.number().optional(),
  }),

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { input, optional } = params as { input: string; optional?: number };

    const startedAt = Date.now();

    try {
      // 实现工具逻辑
      const result = await doSomething(input, optional);

      return {
        toolName: "my_custom_tool",
        success: true,
        result,
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        toolName: "my_custom_tool",
        success: false,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// 2. 注册工具
import { ToolRegistry } from "./registry";
const registry = new ToolRegistry();
registry.register(myCustomTool);
```

---

## 配置

工具系统通过配置文件控制：

```yaml
# config.yml
tools:
  # 工具调用超时（毫秒）
  timeout: 30000

  # 并发控制（Agent 全局设置中也有）
  maxConcurrent: 3

  # 文件访问白名单
  allowedPaths:
    - "./data"
    - "./docs"
    - "./src"

  # 网络搜索配置
  webSearch:
    provider: "tavily"  # "tavily" | "google" | "bing" | "duckduckgo"
    apiKey: "${WEB_SEARCH_API_KEY}"
    maxResults: 10

  # MCP 服务器配置
  mcpServers:
    - name: "filesystem"
      url: "http://localhost:3000"
      enabled: true
    - name: "database"
      url: "http://localhost:3001"
      enabled: false
```

---

## 错误处理

### 工具错误类型

```typescript
class ToolError extends Error {
  constructor(
    public toolName: string,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

class ToolNotFoundError extends ToolError {
  constructor(toolName: string) {
    super(toolName, `Tool "${toolName}" not found`);
    this.name = "ToolNotFoundError";
  }
}

class ToolValidationError extends ToolError {
  constructor(toolName: string, validationErrors: unknown) {
    super(toolName, "Parameter validation failed", validationErrors);
    this.name = "ToolValidationError";
  }
}

class ToolTimeoutError extends ToolError {
  constructor(toolName: string, timeout: number) {
    super(toolName, `Tool execution timed out after ${timeout}ms`);
    this.name = "ToolTimeoutError";
  }
}

class ToolPermissionError extends ToolError {
  constructor(toolName: string, message: string) {
    super(toolName, `Permission denied: ${message}`);
    this.name = "ToolPermissionError";
  }
}
```

### 错误恢复策略

```typescript
// 当工具失败时，Reflector 可以决定：
// 1. continue - 忽略错误，继续执行下一步
// 2. replan - 修改计划，可能使用备用工具
// 3. complete - 尽管有错误，任务也算完成（部分成功）

interface Reflection {
  verdict: "complete" | "continue" | "replan";
  assessment: string;
  lessons: string[];
  nextFocus?: string;
  toolFailures?: {
    toolName: string;
    error: string;
    suggestion?: string;
  }[];
}
```

---

## 测试

工具测试策略：

```typescript
// 工具单元测试示例
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
    expect(result.error).toContain("Access denied");
  });
});
```

---

## 性能考虑

| 关注点 | 策略 |
|--------|------|
| 并发控制 | 使用 Semaphore 限制并发数，避免资源耗尽 |
| 超时 | 每个工具设置合理超时，避免无限等待 |
| 缓存 | 对只读操作（如文件读取）实现内存缓存 |
| 批处理 | 支持批量操作（如 `list_files` 的递归模式） |
| 资源清理 | 确保网络连接、文件句柄等正确释放 |

---

## 未来扩展

1. **流式工具**：支持流式返回（如日志实时输出）
2. **工具链**：支持工具组合和管道操作
3. **工具依赖**：声明工具间的依赖关系，自动解析执行顺序
4. **工具版本**：支持同一工具的多个版本
5. **工具审计**：详细的工具调用审计日志
6. **A/B 测试**：对不同工具实现进行 A/B 测试
