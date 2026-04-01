# Pegasus 可观测性设计方案（v2 — Architect Review 后修订）

> Author: Dev  
> Reviewer: Architect  
> Status: **v2 — Architect Review 修正完成**  
> Date: 2026-03-31  
> 输入：`oc-shared/docs/pegasus-observability-plan.md`（初稿）+ 源码审查 + Architect spec

---

## 0. 执行摘要

基于建军初稿、完整源码审查、以及 Architect Review 的 3 项偏差修正，本文档是可执行的工程设计方案。

**v2 修订内容**（回应 Architect Review）：
1. ✅ **偏差 1 修正**：放弃 EventBus 订阅策略 → 改为 Agent 工具执行路径直接埋点（`_executeToolAsync` 中包裹 span）
2. ✅ **偏差 2 修正**：放弃 `TelemetryCollector.activeTraceId` 全局状态 → 改为 `AgentExecutionState.traceId` per-agent 传播
3. ✅ **偏差 3 修正**：SpanWriter flush 间隔从 5s/100条 → 1s/10条，加 `process.on('beforeExit')` 兜底
4. ✅ **改进 1 采纳**：保持单一 `telemetry_query` tool（已优于 spec）
5. ✅ **改进 3 采纳**：Memory span 识别通过 ToolContext.kind 标记，不依赖 `toolName.startsWith('memory_')`
6. ✅ **改进 4 采纳**：轮转文件命名改为日期后缀（`traces.2026-03-30.jsonl`）

核心变更：
1. **新增 `src/telemetry/` 模块**（~8 个文件）：Span 采集、Metrics 聚合、Health 检查
2. **6 个现有文件加埋点**（非侵入式 wrapper）
3. **CLI 子命令 + 1 个 Agent Tool**
4. **零外部依赖，零认知管线改动**

---

## 1. 现状分析（源码审查确认）

| 已有组件 | 文件 | 能力 | 缺口 |
|----------|------|------|------|
| `AppStats` | `src/stats/app-stats.ts` | 内存 mutable struct，500ms TUI 轮询 | 重启丢失，无时间维度 |
| `StatsPersistence` | `src/stats/stats-persistence.ts` | `stats.json` 累计 LLM/tool 计数 | 只有总数，无趋势 |
| `Logger (pino)` | `src/infra/logger.ts` | JSON 日志 + pino-roll 轮转 | 无结构化 trace，无因果链 |
| `EventBus` | `src/agents/events/bus.ts` | 优先队列事件分发（13 种 EventType） | 事件不持久化，不可查询 |
| `ToolExecutor` | `src/agents/tools/executor.ts` | 执行 + 超时 + 事件发射 | 无 span 记录 |
| `Agent.onLLMUsage()` | `src/agents/agent.ts:608` | 每次 LLM 调用后记录 token | latencyMs 始终为 0，无 traceId |
| `Agent._compactState()` | `src/agents/agent.ts:1098` | context 压缩 | 无压缩前后 token 对比记录 |
| `Reflection` | `src/agents/reflection.ts` | 会话反思提取 facts/episodes | 无执行指标记录 |

**关键发现**：

1. `Agent.onLLMUsage()` 的 `latencyMs` 始终传 `0`——需要在 `processStep()` 中计时
2. `ToolExecutor.execute()` 已有 `startedAt`/`durationMs` 计算——结果可直接用于 span
3. `emitCompletion()` 不设 `parentEventId`（Architect 验证）——**EventBus 事件配对不可行**
4. Memory 工具走 `ToolExecutor` 通道——通过 ToolContext 标记 kind 即可区分
5. `AgentExecutionState` 已有 per-agent 状态——是 traceId 传播的天然载体

---

## 2. 设计原则

| # | 原则 | 落地方式 |
|---|------|---------|
| 1 | **零外部依赖** | 纯 Node.js `fs` + `readline`，不引入 Prometheus/Grafana/OTel |
| 2 | **文件优先** | JSONL 落盘，可被外部工具 `cat/jq/grep` 直接分析 |
| 3 | **不改认知管线** | Span 采集通过已有 hook 点的 additive 代码，不改 processStep 控制流 |
| 4 | **AppStats 不变** | TUI 轮询模型、接口签名完全不动 |
| 5 | **EventBus 不耦合** | TelemetryCollector 不订阅 EventBus，不占消费槽位 |
| 6 | **渐进交付** | Phase 1 有数据 → Phase 2 有聚合 → Phase 3 有看板 |
| 7 | **异步非阻塞** | 所有 IO 操作异步 + buffer 批量写入，fire-and-forget |

---

## 3. 架构设计

### 3.1 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                          PegasusApp                              │
│                                                                  │
│  Agent.onLLMUsage() ─────────┐                                   │
│  Agent._compactState() ──────┤                                   │
│  Agent._executeToolAsync() ──┤── span() ──► TelemetryCollector   │
│  memory tools (via ctx) ─────┤              (in-process singleton)│
│  Reflection.runReflection() ─┤                                   │
│  Pegasus.routeMessage() ─────┘              │                    │
│                                      ┌──────┴──────┐            │
│                                      ▼             ▼            │
│                                 TraceStore    MetricsAggr        │
│                              (buffer→JSONL)  (accumulate→flush)  │
│                                      │             │            │
│                                      ▼             ▼            │
│                           traces.jsonl      metrics.jsonl        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐        │
│  │ AppStats (不变) │ EventBus (不变) │ pino Logger (不变) │        │
│  └──────────────────────────────────────────────────────┘        │
│                                                                  │
│  ┌──────────────────┐   ┌──────────────────┐                     │
│  │ CLI: trace/metrics│   │ Tool: telemetry_ │                     │
│  │ health commands   │   │ query (Agent用)  │                     │
│  └──────────────────┘   └──────────────────┘                     │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 采集策略：全部直接埋点（v2 修正）

**v1 用 EventBus 订阅 TOOL_CALL_* → v2 改为在 Agent 代码中直接记录 span。**

修正理由（Architect Review 偏差 1）：
- EventBus 是认知管线优先级队列，telemetry handler 占消费槽位
- `emitCompletion()` 不设 `parentEventId`，导致 REQUESTED/COMPLETED 无法配对
- 直接在 `_executeToolAsync()` 中记录，时序精度更高

| 采集点 | 位置 | 侵入度 |
|--------|------|--------|
| **LLM 调用** | `Agent.onLLMUsage()` 末尾 +15 行 | 低 |
| **Agent Step** | `Agent.processStep()` 入口/出口 +7 行 | 低 |
| **工具执行** | `Agent._executeToolAsync()` 中 execute() 返回后 +15 行 | 低（ToolExecutor.ts 不改） |
| **Memory 操作** | 4 个 memory tool 各 +3 行（通过 ToolContext 注入） | 极低 |
| **Compact** | `Agent._compactState()` 首尾 +4 行 | 极低 |
| **消息接收** | `Pegasus.routeMessage()` +12 行 | 低 |
| **Reflection** | `Reflection.runReflection()` 首尾 +4 行 | 极低 |

### 3.3 traceId 传播策略（v2 修正）

**v1 用 TelemetryCollector.activeTraceId 全局状态 → v2 改为 per-agent state 传播。**

修正理由（Architect Review 偏差 2）：
- 全局 `activeTraceId` 在并发场景（MainAgent + SubAgent 同时执行）会被覆盖
- `AgentExecutionState` 已有 per-agent 实例，是 traceId 的天然载体

```typescript
// src/agents/base/execution-state.ts — 增加 2 个可选字段
interface AgentExecutionState {
  // ...existing fields...
  traceId?: string;        // 当前处理链的 trace ID
  currentSpanId?: string;  // 当前活跃 span ID（用于 parent-child 关系）
}
```

传播路径：
```
routeMessage() → traceId = shortId()
  → agent.send(message) → state.traceId = traceId
    → processStep() → 从 state.traceId 读取
      → onLLMUsage() → 从 state.traceId 读取
      → _executeToolAsync() → 从 state.traceId 读取
        → buildToolContext() → ctx.traceId = state.traceId
          → memory tools → 从 context.traceId 读取
      → _compactState() → 从 state.traceId 读取
    → onCompacted() → reflection 继承 traceId
```

---

## 4. 数据模型

### 4.1 Span（Trace 数据单元）

```typescript
// src/telemetry/types.ts

type SpanKind = "agent" | "llm" | "tool" | "memory" | "reflection" | "system";

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;              // e.g. "llm.call", "tool.shell_exec", "agent.compact"
  kind: SpanKind;
  startMs: number;           // Unix ms
  durationMs: number;
  status: "ok" | "error";
  errorMessage?: string;     // 仅 status === "error" 时有值
  attributes: Record<string, string | number | boolean>;
}
```

**Span `attributes` 按 kind 的标准字段**：

| kind | 必填 attributes | 可选 attributes |
|------|----------------|----------------|
| `llm` | `model`, `promptTokens`, `outputTokens`, `latencyMs` | `cacheReadTokens`, `cacheWriteTokens`, `agentId`, `iteration` |
| `tool` | `toolName`, `success`, `durationMs` | `resultSize`, `error`, `agentId` |
| `memory` | `toolName`, `operation`, `success` | `path`, `sizeBytes` |
| `agent` | `agentId` | `iteration`, `beforeTokens`, `afterTokens`, `beforeMessages`, `afterMessages` |
| `reflection` | `agentId`, `messageCount` | `toolCallsCount`, `assessment` |
| `system` | `channel` | `channelId` |

### 4.2 MetricRecord（时序指标聚合单元）

```typescript
interface MetricRecord {
  periodStart: number;       // Unix ms, 整小时对齐
  periodEnd: number;         // periodStart + 3600000
  llm: {
    byModel: Record<string, {
      calls: number;
      promptTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalLatencyMs: number;
      latencies: number[];   // 原始延迟值，flush 时计算百分位
    }>;
  };
  tools: {
    byTool: Record<string, {
      calls: number;
      successes: number;
      failures: number;
      totalLatencyMs: number;
      latencies: number[];
    }>;
  };
  subagents: { spawned: number; completed: number; failed: number };
  messages: { byChannel: Record<string, number> };
  compacts: { count: number; totalTokensSaved: number };
}
```

### 4.3 HealthStatus

```typescript
type HealthLevel = "healthy" | "degraded" | "critical";

interface HealthCheck {
  name: string;
  level: HealthLevel;
  value: number;
  threshold: { degraded: number; critical: number };
  message: string;
}

interface HealthStatus {
  timestamp: number;
  overall: HealthLevel;
  checks: HealthCheck[];
}
```

---

## 5. 存储方案

### 5.1 文件布局

```
~/.pegasus/
├── telemetry/
│   ├── traces.jsonl                # 当前活跃 Span 数据
│   ├── traces.2026-03-30.jsonl     # 日期后缀轮转归档
│   ├── traces.2026-03-29.jsonl
│   ├── metrics.jsonl               # 当前小时级聚合指标
│   ├── metrics.2026-03.jsonl       # 月度归档
│   └── health-snapshot.json        # 最近一次健康检查快照
├── stats.json                      # 保持不变
└── logs/
    └── pegasus.log                 # 保持不变
```

### 5.2 轮转与保留策略

| 文件 | 轮转策略 | 保留期 | 预估体积 |
|------|---------|--------|---------|
| `traces.jsonl` | 每日轮转 OR 达到 50MB | 14 天 | 2-5 MB/天 |
| `metrics.jsonl` | 每月轮转 | 90 天 | ~50 KB/天 |
| `health-snapshot.json` | 覆写（只保留最新） | — | < 1KB |

**总磁盘占用上限**：500MB 硬限。轮转时自动清理最旧文件。

### 5.3 写入机制（v2 修正）

```typescript
// src/telemetry/span-writer.ts

class SpanWriter {
  private buffer: string[] = [];
  private flushTimer: NodeJS.Timer;
  private writeStream: fs.WriteStream;

  constructor(filePath: string) {
    this.writeStream = fs.createWriteStream(filePath, { flags: 'a' });
    // v2: 1 秒 flush + 10 条 buffer 上限（Architect 修正偏差 3）
    this.flushTimer = setInterval(() => this.flush(), 1000);
    // 进程退出兜底
    process.on('beforeExit', () => this.flush());
  }

  write(span: Span): void {
    this.buffer.push(JSON.stringify(span));
    if (this.buffer.length >= 10) this.flush();  // v2: 10条立即 flush
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.join('\n') + '\n';
    this.buffer = [];
    this.writeStream.write(batch); // 非阻塞，fire-and-forget
  }

  async close(): Promise<void> {
    clearInterval(this.flushTimer);
    this.flush();
    await new Promise(resolve => this.writeStream.end(resolve));
  }
}
```

**v1→v2 变更**：5s/100条 → 1s/10条。进程异常退出最多丢 10 条 span（约 1 秒数据），可接受。

---

## 6. 模块设计

### 6.1 TelemetryCollector（核心枢纽）

```typescript
// src/telemetry/collector.ts

class TelemetryCollector {
  private traceStore: TraceStore;
  private metricsAggregator: MetricsAggregator;

  constructor(opts: { telemetryDir: string; traceRetentionDays?: number; maxTraceFileSizeBytes?: number })

  // ── Span API ──

  /** 创建 root span（无 parent） */
  startSpan(name: string, kind: SpanKind): SpanBuilder

  /** 创建 child span */
  startChildSpan(name: string, kind: SpanKind, traceId: string, parentSpanId: string): SpanBuilder

  /** 直接记录完整 span */
  recordSpan(span: Span): void

  // ── Metrics API（Phase 2）──

  counter(name: string, value: number, labels?: Record<string, string>): void
  histogram(name: string, value: number, labels?: Record<string, string>): void
  gauge(name: string, value: number, labels?: Record<string, string>): void

  // ── Lifecycle ──

  async shutdown(): Promise<void>
}
```

**关键决策**：TelemetryCollector 是纯数据收集器，**不订阅 EventBus，不持有全局 trace state**。traceId 由调用者通过参数传入。

### 6.2 SpanBuilder（流式构建）

```typescript
// src/telemetry/span.ts

class SpanBuilder {
  constructor(collector: TelemetryCollector, name: string, kind: SpanKind, traceId: string, parentSpanId: string | null)

  attr(key: string, value: string | number | boolean): this
  attrs(kvs: Record<string, string | number | boolean>): this
  end(): void        // 写入 TraceStore，status = "ok"
  error(msg: string): void  // 写入 TraceStore，status = "error"
  get spanId(): string
  get traceId(): string
}
```

### 6.3 MetricsAggregator

```typescript
// src/telemetry/metrics-aggregator.ts

class MetricsAggregator {
  // 内存中按小时窗口累加
  // ingest(span) 从 span 提取指标
  // flush() 每小时写一条 MetricRecord 到 metrics.jsonl
  // 1 分钟 flush interval（Architect spec）
}
```

### 6.4 TraceQuery / MetricsQuery / HealthChecker

与 v1 设计相同，不赘述。查询层不受采集策略变更影响。

---

## 7. 精确埋点方案（v2 修正）

### 7.1 LLM 调用 — `processStep()` + `onLLMUsage()`

在 `processStep()` 中加 LLM 调用计时：

```typescript
// agent.ts:735 — model.generate() 前后
const llmStartMs = Date.now();
const result = await this.model.generate({ ... });
const llmDurationMs = Date.now() - llmStartMs;

state.iteration++;
state.lastPromptTokens = ...;
await this.onLLMUsage(result, llmDurationMs);  // 新增 durationMs 参数
```

在 `onLLMUsage()` 末尾记录 span：

```typescript
protected async onLLMUsage(result: GenerateTextResult, durationMs?: number): Promise<void> {
  // ...现有 AppStats 逻辑不变...

  // Telemetry: LLM span
  if (this._telemetry) {
    const state = this.subagentStates.get(this.agentId);
    if (state?.traceId) {
      this._telemetry.recordSpan({
        traceId: state.traceId,
        spanId: shortId(),
        parentSpanId: state.currentSpanId ?? null,
        name: "llm.call",
        kind: "llm",
        startMs: Date.now() - (durationMs ?? 0),
        durationMs: durationMs ?? 0,
        status: "ok",
        attributes: {
          model: this.model.modelId,
          promptTokens: result.usage.promptTokens ?? 0,
          outputTokens: result.usage.completionTokens ?? 0,
          cacheReadTokens: result.usage.cacheReadTokens ?? 0,
          cacheWriteTokens: result.usage.cacheWriteTokens ?? 0,
          latencyMs: durationMs ?? 0,
          agentId: this.agentId,
          iteration: state.iteration,
        },
      });
    }
  }
}
```

**侵入度**：processStep +2 行计时，onLLMUsage +15 行末尾追加。

### 7.2 工具执行 — `_executeToolAsync()`（v2 修正）

**v1 用 EventBus 订阅 → v2 直接在 Agent 的工具执行路径中记录。**

在 `_executeToolAsync()` 中，`toolExecutor.execute()` 返回后、`emitCompletion()` 之后添加：

```typescript
// agent.ts — _executeToolAsync() 中，result 返回后

const result = await this.toolExecutor.execute(tc.name, tc.arguments, ctx);
this.toolExecutor.emitCompletion(tc.name, result, ctx);

// AppStats（现有，不变）
if (this._appStats) {
  recordToolCall(this._appStats, result.success);
}

// Telemetry: tool span（v2 新增）
if (this._telemetry && state?.traceId) {
  const kind = ctx.toolKind === 'memory' ? 'memory' : 'tool';  // v2: 用 ToolContext.toolKind
  this._telemetry.recordSpan({
    traceId: state.traceId,
    spanId: shortId(),
    parentSpanId: state.currentSpanId ?? null,
    name: kind === 'memory' ? `memory.${tc.name.replace('memory_', '')}` : `tool.${tc.name}`,
    kind,
    startMs: result.startedAt ?? Date.now(),
    durationMs: result.durationMs ?? 0,
    status: result.success ? "ok" : "error",
    errorMessage: result.error,
    attributes: {
      toolName: tc.name,
      success: result.success,
      durationMs: result.durationMs ?? 0,
      agentId: state.agentId,
    },
  });
}
```

**侵入度**：+15 行，ToolExecutor.ts 不改。

### 7.3 Memory Kind 标记（v2 修正）

**v1 用 `toolName.startsWith('memory_')` → v2 通过 ToolContext 标记。**

```typescript
// src/agents/tools/types.ts — ToolContext 扩展
interface ToolContext {
  // ...existing fields...
  telemetry?: TelemetryCollector;
  traceId?: string;
  parentSpanId?: string;
  toolKind?: 'tool' | 'memory';  // v2: 明确标记 kind
}
```

在 `Agent.buildToolContext()` 中注入：

```typescript
protected buildToolContext(agentId: string): ToolContext {
  const ctx: ToolContext = { agentId };
  // ...existing injections...
  if (this._telemetry) {
    const state = this.subagentStates.get(agentId);
    ctx.telemetry = this._telemetry;
    ctx.traceId = state?.traceId;
    ctx.parentSpanId = state?.currentSpanId;
  }
  return ctx;
}
```

Memory 工具调用时，通过 `_executeToolAsync` 中检测 toolName 设置 `ctx.toolKind`（或在 buildToolContext 中根据 tool registry 的 category 判断）。

### 7.4 Compact 埋点

```typescript
// agent.ts — _compactState()

protected async _compactState(agentId: string): Promise<void> {
  const state = this.subagentStates.get(agentId);
  if (!state) return;

  const compactStartMs = Date.now();
  const beforeMessages = state.messages.length;

  // ...现有 compact 逻辑完全不变...

  // Telemetry: compact span
  if (this._telemetry && state.traceId) {
    this._telemetry.recordSpan({
      traceId: state.traceId,
      spanId: shortId(),
      parentSpanId: state.currentSpanId ?? null,
      name: "agent.compact",
      kind: "agent",
      startMs: compactStartMs,
      durationMs: Date.now() - compactStartMs,
      status: "ok",
      attributes: { agentId, beforeMessages, afterMessages: state.messages.length },
    });
  }
}
```

**侵入度**：+4 行。

### 7.5 Reflection 埋点

```typescript
// reflection.ts — runReflection()

async runReflection(agentId: string, sessionMessages: Message[], traceId?: string): Promise<void> {
  const startMs = Date.now();
  // ...现有逻辑完全不变...

  // Telemetry
  if (this._telemetry) {
    this._telemetry.recordSpan({
      traceId: traceId ?? shortId(),
      spanId: shortId(),
      parentSpanId: null,
      name: "reflection.run",
      kind: "reflection",
      startMs,
      durationMs: Date.now() - startMs,
      status: "ok",
      attributes: { agentId, messageCount: sessionMessages.length, toolCallsCount: reflection.toolCallsCount },
    });
  }
}
```

**侵入度**：+8 行，签名加可选 `traceId` 参数。

### 7.6 消息接收 — `routeMessage()`

```typescript
// pegasus.ts — routeMessage()

routeMessage(message: InboundMessage): void {
  const traceId = shortId();

  if (this._telemetry) {
    this._telemetry.recordSpan({
      traceId, spanId: shortId(), parentSpanId: null,
      name: "message.received", kind: "system",
      startMs: Date.now(), durationMs: 0, status: "ok",
      attributes: { channel: message.channel.type },
    });
  }

  // 传递 traceId 给 Agent（通过 message metadata 或直接注入 state）
  // ...existing routing logic...
}
```

---

## 8. 注入策略

### 8.1 PegasusApp.start() 创建 + 注入

```typescript
// pegasus.ts — start() 中，AppStats 创建之后

const telemetryDir = path.join(this.settings.homeDir, "telemetry");
this._telemetry = new TelemetryCollector({
  telemetryDir,
  traceRetentionDays: 14,
  maxTraceFileSizeBytes: 50 * 1024 * 1024,
});

// 注入 InjectedSubsystems（类比 appStats）
const injected: InjectedSubsystems = {
  // ...existing fields...
  telemetry: this._telemetry,  // new
};
```

### 8.2 Agent 接收

```typescript
// agent.ts — 类比 _appStats 的注入模式
export interface AgentDeps {
  // ...existing...
  telemetry?: TelemetryCollector;
}

// constructor:
this._telemetry = deps.telemetry ?? null;
```

### 8.3 Shutdown

```typescript
// pegasus.ts — stop()
async stop(): Promise<void> {
  // ...existing shutdown...
  if (this._telemetry) {
    await this._telemetry.shutdown();
  }
}
```

---

## 9. CLI 命令设计

### 9.1 Trace 命令

```bash
pegasus trace list [--last 1h|24h|7d] [--kind llm|tool|agent] [--status error]
pegasus trace show <traceId>       # 树状展示完整调用链
pegasus trace slow [--top 10]      # 最慢 trace 排行
```

### 9.2 Metrics 命令

```bash
pegasus metrics summary [--period 24h|7d|30d]
pegasus metrics tokens [--by model|hour|day]
pegasus metrics tools [--sort errors|calls|latency]
pegasus metrics cost [--period 30d]
```

### 9.3 Health 命令

```bash
pegasus health
```

健康检查阈值：

| 检查项 | 🟢 Healthy | 🟡 Degraded | 🔴 Critical |
|--------|-----------|-------------|-------------|
| LLM 延迟 P95 | < 5s | 5-15s | > 15s |
| 工具失败率 | < 5% | 5-20% | > 20% |
| Context 使用率 | < 70% | 70-90% | > 90% |
| Memory facts 大小 | < 10KB | 10-14KB | ≥ 15KB |
| Compact 频率 | < 3/hour | 3-10/hour | > 10/hour |
| 子任务失败率 | < 10% | 10-30% | > 30% |

---

## 10. Agent Tool 设计

单一 `telemetry_query` tool（合并 trace/metrics/health 查询，LLM 选择更准确）：

```typescript
// src/agents/tools/builtins/telemetry-tools.ts

export const telemetry_query: Tool = {
  name: 'telemetry_query',
  description: 'Query system telemetry: traces, metrics, and health status',
  parameters: z.object({
    type: z.enum(['trace_list', 'trace_show', 'trace_slow', 'metrics_summary',
                   'metrics_tokens', 'metrics_tools', 'health']),
    traceId: z.string().optional(),
    period: z.string().optional(),
    limit: z.number().optional(),
    kind: z.string().optional(),
    sortBy: z.string().optional(),
  }),
  async execute(params, context) {
    // 委托给 TraceQuery / MetricsQuery / HealthChecker
  },
};
```

---

## 11. 代码变更清单

### 新增文件

| 文件 | 职责 | Phase | 预估行数 |
|------|------|-------|---------|
| `src/telemetry/types.ts` | 类型定义 | 1 | ~80 |
| `src/telemetry/collector.ts` | TelemetryCollector + SpanBuilder | 1 | ~200 |
| `src/telemetry/trace-store.ts` | JSONL 写入 + buffer + 轮转 + 查询 | 1 | ~250 |
| `src/telemetry/metrics-aggregator.ts` | 指标累加器 + flush | 2 | ~200 |
| `src/telemetry/metrics-query.ts` | 指标查询引擎 | 2 | ~120 |
| `src/telemetry/health.ts` | 健康检查器 | 3 | ~120 |
| `src/telemetry/index.ts` | 统一导出 | 1 | ~15 |
| `src/agents/tools/builtins/telemetry-tools.ts` | Agent 自查询工具 | 1 | ~100 |
| `src/cli-commands/trace.ts` | CLI trace 子命令 | 1 | ~80 |
| `src/cli-commands/metrics.ts` | CLI metrics 子命令 | 2 | ~80 |
| `src/cli-commands/health.ts` | CLI health 子命令 | 3 | ~60 |
| `tests/telemetry/*.test.ts` | 单元测试 | 1-3 | ~400 |

### 修改文件

| 文件 | 改动描述 | 改动量 | Phase |
|------|---------|--------|-------|
| `src/agents/agent.ts` | `_telemetry` 字段 + onLLMUsage 加 durationMs + processStep 计时 + _executeToolAsync span + _compactState span | ~60 行 | 1 |
| `src/agents/base/execution-state.ts` | 增加 `traceId?` + `currentSpanId?` | +2 行 | 1 |
| `src/agents/tools/types.ts` | ToolContext 增加 telemetry/traceId/parentSpanId/toolKind | +4 行 | 1 |
| `src/agents/reflection.ts` | 加 `_telemetry` + span + 可选 traceId 参数 | ~8 行 | 1 |
| `src/agents/main-agent.ts` | InjectedSubsystems 增加 telemetry 字段 | +3 行 | 1 |
| `src/pegasus.ts` | 创建 TelemetryCollector + routeMessage span + 注入 + shutdown | ~25 行 | 1 |
| `src/cli.ts` | 子命令 argv 路由 | ~15 行 | 1 |
| `src/agents/tools/builtins/index.ts` | 注册 `telemetry_query` tool | +3 行 | 1 |

### 不动的文件

| 文件 | 理由 |
|------|------|
| `src/stats/app-stats.ts` | TUI 依赖，接口不变 |
| `src/stats/stats-persistence.ts` | stats.json 保留 |
| `src/agents/events/types.ts` | 不新增 EventType |
| `src/agents/events/bus.ts` | EventBus 不感知 Telemetry |
| `src/agents/tools/executor.ts` | ToolExecutor 不改 |
| `src/agents/tools/builtins/memory-tools.ts` | Memory 工具不改（通过 ToolContext 标记 kind） |
| `src/infra/logger.ts` | pino 不变 |
| `src/tui/*` | Phase 3 可选扩展 |

---

## 12. 分阶段交付计划

### Phase 1: Trace — Week 1

**验收标准**：
1. 一条消息触发完整 trace（message.received → agent.step → llm.call → tool.* 树结构）
2. `traces.jsonl` 中 traceId/parentSpanId 形成正确的树
3. `pegasus trace show <traceId>` 展示调用链树
4. `pegasus trace slow --top 5` 排序正确
5. Agent 自查 trace 可用
6. 所有现有测试通过（零回归）
7. 文件轮转：按日期命名，超期自动清理

### Phase 2: Metrics — Week 2

**验收标准**：
1. 运行 1 小时后 `metrics.jsonl` 有聚合记录
2. `pegasus metrics tokens --by model` 正确
3. `pegasus metrics tools --sort errors` 正确
4. counter 累加正确，histogram percentile 正确

### Phase 3: Health — Week 3

**验收标准**：
1. `pegasus health` 输出全项检查（绿/黄/红）
2. 人为制造异常后状态变色
3. Agent 自查 health 可用

---

## 13. 风险评估

| # | 风险 | 概率 | 影响 | 缓解措施 |
|---|------|------|------|---------|
| 1 | Span 写入阻塞主线程 | 低 | 高 | 异步 buffer + fire-and-forget；写入失败只 warn 日志 |
| 2 | JSONL 文件膨胀 | 中 | 中 | 14天轮转 + 50MB 单文件 + 500MB 总量硬限 |
| 3 | traceId 传播遗漏 | 中 | 低 | per-agent state 覆盖主路径；旁路操作单独生成 traceId |
| 4 | 查询 JSONL 性能 | 低 | 低 | 按日期文件过滤 + limit + 流式 readline |
| 5 | 埋点代码侵入 | 中 | 低 | `if (this._telemetry)` 守护，不存在时零开销 |
| 6 | SubAgent telemetry 传播 | 低 | 低 | 同一 collector 实例，traceId 在 submit() 时从父传子 |
| 7 | 并发写入 JSONL | 极低 | 低 | 单一 TraceStore 实例，Node.js 单线程 flush |

---

## 14. 后续演进（Out of Scope）

| 演进方向 | 预留点 |
|---------|--------|
| OTel 导出 | Span 格式对齐 OTel Span schema |
| Prometheus | MetricsQuery 可输出 Prometheus 文本格式 |
| Web Dashboard | JSONL 可被外部工具读取 |
| 成本核算 | estimateCost() 预留价格文件接口 |
| 主动告警 | HealthChecker 可接 Heartbeat |

---

## 15. Architect Review 修正记录

| 偏差/建议 | v1 | v2 | 状态 |
|-----------|----|----|------|
| 偏差 1：EventBus 订阅 | 订阅 TOOL_CALL_* 事件 | 在 _executeToolAsync() 直接埋点 | ✅ 已修正 |
| 偏差 2：全局 traceId | TelemetryCollector.activeTraceId | AgentExecutionState.traceId | ✅ 已修正 |
| 偏差 3：flush 间隔 | 5s / 100条 | 1s / 10条 + beforeExit 兜底 | ✅ 已修正 |
| 建议 1：合并 tool | 已是单一 telemetry_query | 保持 | ✅ 已采纳 |
| 建议 2：onLLMUsage 签名 | 加 durationMs? 参数 | 保持（向后兼容，可接受） | ✅ Architect 确认可接受 |
| 建议 3：Memory kind 识别 | toolName.startsWith('memory_') | ToolContext.toolKind 标记 | ✅ 已采纳 |
| 建议 4：轮转文件命名 | traces.jsonl.1 数字后缀 | traces.2026-03-30.jsonl 日期后缀 | ✅ 已采纳 |

---

*v2 方案完成。3 个架构偏差已修正，4 个改进建议已处理。请建军审阅后确认进入实现。*
