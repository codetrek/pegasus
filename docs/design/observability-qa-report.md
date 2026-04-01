# Pegasus 可观测性方案 — QA 综合报告

> Role: QA  
> Status: **Ready for Review**  
> Date: 2026-03-31  
> 输入：`docs/design/observability-design.md`（Architect 设计方案 v2，已经 Architect 确认）

---

## Part A：PM 产品视角补充

### A.1 用户核心问题清单（按优先级排序）

| 优先级 | 维度 | 建军需要回答的问题 | 当前状态 | 方案覆盖 |
|--------|------|-----------------|---------|---------|
| P0 | 故障排查 | 刚才那个任务为什么这么慢？卡在哪一步？ | 只能 grep 日志，无因果链 | Phase 1 Trace |
| P0 | 故障排查 | 工具调用失败了，是哪个工具，错误是什么？ | 日志有但难查 | Phase 1 Trace |
| P1 | 成本控制 | 这周/这月花了多少 token？按模型分别是多少？ | stats.json 有总数，无时间维度 | Phase 2 Metrics |
| P1 | 成本控制 | 哪个任务最"贵"？消耗 token 最多的操作是什么？ | 无法回答 | Phase 1+2 |
| P1 | 健康监控 | 系统现在健康吗？有没有异常？ | 无系统级健康视图 | Phase 3 Health |
| P2 | 行为审计 | Pegasus 昨天做了什么？执行了哪些工具？ | 只能翻日志文件 | Phase 1 Trace |
| P2 | 性能优化 | Memory 检索命中率怎样？是否在浪费 context？ | 无 | Phase 1+2 |
| P2 | 性能优化 | Compact 触发频率是否异常？每次能节省多少 token？ | 只有计数，无节省量 | Phase 2 Metrics |
| P3 | 容量规划 | Pegasus 的日均 token 消耗趋势是涨还是跌？ | 无趋势数据 | Phase 2 Metrics |
| P3 | 容量规划 | 子任务失败率是否在上升？ | 无时序数据 | Phase 2 Metrics |

### A.2 CLI 命令完整规格与输出示例

#### `pegasus trace list`
```bash
$ pegasus trace list --last 1h --status error

TraceId          Started              Duration  Spans  Status
──────────────────────────────────────────────────────────────
abc123def        14:25:01 (35min ago)  12.5s     8     ❌ error
xyz789abc        14:18:44 (42min ago)   3.2s     4     ❌ error

2 traces found (1h window, error only)
```

#### `pegasus trace show <traceId>`
```bash
$ pegasus trace show abc123def

Trace abc123def  2026-03-31 14:25:01  total: 12.5s
──────────────────────────────────────────────────
─ agent.step [12500ms]
  ├─ llm.call  claude-sonnet [8500ms]  prompt=1200 output=350 cache=800
  ├─ tool.shell_exec [2100ms]  ✓  exit=0
  ├─ memory.read [15ms]  ✓  path=facts/user.md size=2.1KB
  ├─ tool.shell_exec [1200ms]  ✗  error="command not found: foo"
  └─ llm.call  claude-sonnet [680ms]  prompt=1800 output=120
```

#### `pegasus trace slow --top 5`
```bash
$ pegasus trace slow --top 5 --last 24h

Rank  TraceId     Started     TotalMs  Bottleneck
─────────────────────────────────────────────────
 #1   abc123def  14:25:01    12500ms  llm.call (68%)
 #2   def456ghi  11:03:22     9800ms  tool.shell_exec (54%)
 #3   ghi789jkl  09:15:44     7200ms  llm.call (71%)
 #4   jkl012mno  08:52:11     5100ms  reflection.run (49%)
 #5   mno345pqr  07:30:09     4300ms  memory.write (38%)
```

#### `pegasus metrics summary`
```bash
$ pegasus metrics summary --period 24h

══ Pegasus Metrics (Last 24h) ══════════════════════
  LLM Calls    47      Tokens: 125K prompt / 32K output
  Cache Hit    18K     (14.4% prompt tokens from cache)
  Tool Calls   89      Success Rate: 96.6%  (3 failures)
  Compacts      3      Tokens Saved: ~45K
  Subagents     5      4 completed / 1 failed
  Messages     12      discord: 9 / telegram: 3
════════════════════════════════════════════════════
```

#### `pegasus metrics tokens --by model`
```bash
$ pegasus metrics tokens --by model --period 7d

Model                     Calls  Prompt    Output   Cache    AvgLatency
───────────────────────────────────────────────────────────────────────
claude-sonnet-4-20250514   312   834.2K    201.3K   156.1K      3.2s
claude-haiku-3              48    42.1K     18.7K     8.2K      0.8s
───────────────────────────────────────────────────────────────────────
TOTAL                      360   876.3K    220.0K   164.3K
```

#### `pegasus metrics tools --sort errors`
```bash
$ pegasus metrics tools --sort errors --period 24h

Tool              Calls  Errors  ErrRate  AvgLatency  P95
──────────────────────────────────────────────────────────
shell_exec          34       3    8.8%      1.2s      4.5s
browser_navigate    12       1    8.3%      3.1s      8.2s
memory_write         8       0    0.0%      0.02s     0.05s
memory_read         21       0    0.0%      0.01s     0.03s
```

#### `pegasus health`
```bash
$ pegasus health

══ Pegasus Health ════════════════════════════════
  Overall: 🟡 Degraded

  ✅ LLM Latency P95    2.3s     threshold: <5s
  ✅ Tool Fail Rate     2.1%     threshold: <5%
  ✅ Context Usage      45%      threshold: <70%
  ✅ Memory Facts       6.2KB    threshold: <10KB
  ✅ Compact Rate       1/hr     threshold: <3/hr
  ⚠️  Subagent Fail    15%      threshold: <10%  → 3/20 failed last 1h
══════════════════════════════════════════════════
```

### A.3 Agent Skill 对话设计（自然语言交互示例）

**场景 1：性能诊断**
> 建军："刚才那个任务为什么这么慢？"
> Pegasus：[调用 telemetry_query {type: "trace_slow", limit: 1, period: "30m"}]
> Pegasus："刚才最慢的任务耗时 12.5 秒，主要卡在第一次 LLM 调用（8.5s）——prompt 1200 tokens，缓存命中 800，实际计费 400。之后 shell_exec 也跑了 2.1 秒。"

**场景 2：成本分析**
> 建军："这周花了多少 token？"
> Pegasus：[调用 telemetry_query {type: "metrics_tokens", period: "7d", groupBy: "model"}]
> Pegasus："这周（3/25-3/31）共 LLM 调用 360 次，prompt 876K tokens，output 220K。主力模型 claude-sonnet-4 占 87%，缓存命中 164K token，节省约 18% 计费。"

**场景 3：健康检查**
> 建军："系统现在状态怎样？"
> Pegasus：[调用 telemetry_query {type: "health"}]
> Pegasus："整体 🟡 轻度异常。5 项指标正常，1 项需注意：子任务失败率 15%（3/20 个子任务失败），超过 10% 告警阈值。其余指标均正常。"

**场景 4：故障排查**
> 建军："哪个工具最常出错？"
> Pegasus：[调用 telemetry_query {type: "metrics_tools", sortBy: "errors", period: "24h"}]
> Pegasus："过去 24h，shell_exec 失败率最高（34 次中 3 次失败，8.8%），browser_navigate 次之（12 次中 1 次，8.3%）。Memory 工具全部正常，0 次失败。"

### A.4 信息层级与优先级

**Always-on（TUI 始终显示）：**
- 系统 status（idle/busy）
- 最近一次 LLM 调用延迟 + token
- Context 使用率百分比
- 当前 health overall 状态（颜色指示灯）

**按需查询（CLI/Skill）：**
- 完整 trace 调用链
- 分模型/分工具统计
- 时序趋势数据
- 详细健康检查细节

---

## Part B：QA 测试计划

### B.1 测试策略概述

| 测试层次 | 覆盖重点 | 工具 |
|---------|---------|------|
| 单元测试 | SpanWriter buffer/flush/rotate、MetricsAggregator 聚合逻辑、TraceQuery 过滤排序、HealthChecker 阈值判断 | Vitest |
| 集成测试 | 直接埋点 → Span 生成 → JSONL 落盘全链路 | Vitest + 真实文件系统 (tmpdir) |
| E2E 测试 | 发消息 → 执行任务 → CLI 可查 trace/metrics | 手动 + 脚本 |
| 非侵入性验证 | AppStats/TUI/stats.json 与新模块共存无干扰 | 回归测试 |
| 性能测试 | 主线程无阻塞、写入延迟基准 | 自制 benchmark |

### B.2 Phase 1（Trace）测试计划

#### T1.1 数据正确性

**TC-T1-01：Span 链完整性**
- 前置：Pegasus 运行，telemetry 模块已初始化
- 操作：发送一条需要 LLM 调用 + 工具调用的消息
- 预期：`traces.jsonl` 中出现以下 span，且 traceId 相同：
  - 至少 1 条 `kind: "llm"` span，`durationMs > 0`（验证 latencyMs 修复）
  - 至少 1 条 `kind: "tool"` 或 `kind: "memory"` span
  - 至少 1 条 `kind: "agent"` span（agent.step）
  - 所有 span 的 `traceId` 一致，`parentSpanId` 链接正确

**TC-T1-02：LLM latencyMs 修复验证**
- 操作：触发 1 次 LLM 调用，读取对应 span
- 预期：`attributes.latencyMs > 0`，且与实际调用耗时吻合（误差 < 50ms）
- 验证点：计时位置在 `beforeLLMCall()` 之后、`model.generate()` 之前（不含 compaction 耗时）
- 回归：`stats.json` 中 `totalLatencyMs` 也开始正确累积（不再全是 0）

**TC-T1-03：Memory 工具 kind 标记**
- 操作：触发 `memory_read` 或 `memory_write` 工具调用
- 预期：对应 span 的 `kind === "memory"`（通过 ToolContext.toolKind 标记，v2 实现方案）
- 反例：不出现 `kind: "tool"` + `name: "tool.memory_read"` 的错误标记

**TC-T1-04：traceId per-agent 传播**
- 操作：发送触发多步骤的复杂消息（含多次 LLM + 多个工具）
- 预期：同一 Agent 处理链内所有 span 共享同一 traceId（存储在 AgentExecutionState.traceId）
- 并发场景：同时触发主 Agent + 子 Agent 操作，验证各自 traceId 独立，不相互覆盖

**TC-T1-05：错误 span 记录**
- 操作：构造一个必然失败的工具调用（如不存在的命令）
- 预期：对应 tool span 的 `status === "error"`，`attributes.error` 字段有错误信息

#### T1.2 异步写入可靠性

**TC-T1-06：Buffer 批量 flush（10 条阈值，v2）**
- 注意：v2 实现改为 10 条触发（原 v1 为 100 条）
- 操作：快速产生 10 个 span（通过 `flushIntervalMs=0` 测试模式注入）
- 预期：第 10 条写入后，`traces.jsonl` 行数 = 10

**TC-T1-07：定时 flush（1s 间隔，v2）**
- 注意：v2 实现改为 1 秒（原 v1 为 5 秒）
- 操作：产生 5 个 span，等待 1.5 秒
- 预期：1.5 秒后 `traces.jsonl` 包含这 5 条记录

**TC-T1-08：进程退出时不丢数据（beforeExit 兜底，v2）**
- 操作：产生 5 个 span（不触发 buffer 阈值），调用 `collector.shutdown()`
- 预期：`traces.jsonl` 包含全部 5 条记录，无丢失
- 测试 `process.on('beforeExit')` 是否正确注册并触发最终 flush

**TC-T1-09：主线程无阻塞**
- 操作：在 `collector.recordSpan()` 前后记录时间戳
- 预期：`recordSpan()` 调用耗时 < 0.1ms

**TC-T1-10：flushIntervalMs 参数注入（CI 友好性）**
- 操作：以 `flushIntervalMs=0` 初始化 SpanWriter，写入 1 条 span
- 预期：立即 flush，无需等待定时器

#### T1.3 文件轮转

**TC-T1-11：日期后缀轮转命名（v2）**
- 注意：v2 轮转文件命名为 `traces.2026-03-30.jsonl`（日期后缀），非 `.1` 数字后缀
- 操作：Mock 日期跨天，触发轮转检查
- 预期：旧文件重命名为 `traces.YYYY-MM-DD.jsonl` 格式，新 `traces.jsonl` 重新开始

**TC-T1-12：文件大小触发轮转（50MB，v2）**
- 注意：v2 单文件上限 50MB（原 spec 10MB）
- 操作：写入大量数据使文件超过 50MB
- 预期：触发轮转，新文件从空开始

**TC-T1-13：14 天保留期清理**
- 操作：创建 15 个日期命名的轮转文件，模拟超过 14 天
- 预期：最旧的文件被自动清理，只保留 14 个

**TC-T1-14：500MB 硬限**
- 操作：模拟 telemetry/ 目录总大小超过 500MB
- 预期：触发紧急清理，删除最旧文件直到总大小 < 500MB

#### T1.4 查询正确性

**TC-T1-15：trace show 树状输出**
- 前置：写入一组已知结构的 span（fixtures/sample-spans.jsonl，固定 traceId + parentSpanId）
- 操作：`pegasus trace show <traceId>`
- 预期：输出的缩进树结构与 parentSpanId 关系完全吻合

**TC-T1-16：trace slow 排序**
- 前置：写入 5 个 trace，各有不同 totalDurationMs
- 操作：`pegasus trace slow --top 3`
- 预期：输出按 totalDurationMs 降序排列的前 3 个 trace

**TC-T1-17：trace list 过滤**
- 操作：`pegasus trace list --status error --last 1h`
- 预期：只返回 status=error 且在 1h 内的 trace

**TC-T1-18：非法 JSONL 行容错**
- 前置：在 traces.jsonl 中插入一行非法 JSON（`{broken json`）
- 操作：执行任意 trace 查询
- 预期：非法行被跳过（logger.warn），查询正常返回其他有效数据，不抛错

**TC-T1-19：telemetry_query tool 集成**
- 操作：通过 Agent 调用 `telemetry_query {type: "trace_slow", limit: 3}`
- 预期：返回结构化数据，包含 traceId + totalDurationMs + bottleneck span

#### T1.5 非侵入性回归

**TC-T1-20：AppStats 完全不受影响**
- 操作：加载 telemetry 模块后，运行完整 TUI 会话 5 分钟
- 预期：
  - TUI 500ms 轮询正常，无卡顿
  - AppStats 中所有字段更新正常（llm.byModel, tools.calls 等）
  - `stats.json` 在正常时间点被写入，格式正确

**TC-T1-21：认知管线性能基准**
- 操作：在 telemetry 启用/禁用两种模式下，分别运行 20 次 LLM 调用
- 预期：启用 telemetry 时的平均延迟增加 < 5ms

**TC-T1-22：全量测试回归**
- 操作：`bun test` 跑完整测试套件
- 预期：2322+ tests passing，0 regression（Browser 测试在有 Playwright 环境时也应通过）

### B.3 Phase 2（Metrics）测试计划

**TC-T2-01：小时级聚合正确性**
- 操作：在 1 小时内产生已知数量的 LLM 调用（如 10 次，固定 token 数）
- 预期：flush 后 `metrics.jsonl` 对应记录的 token 求和正确

**TC-T2-02：跨小时边界处理**
- 操作：整点前/后各产生 span
- 预期：两组 span 归入不同 MetricRecord，periodStart 不同

**TC-T2-03：Tool 指标聚合**
- 操作：触发 5 次成功 + 2 次失败的工具调用
- 预期：`calls === 7`，`successes === 5`，`failures === 2`

**TC-T2-04：Compact 指标（token 节省量）**
- 操作：触发 1 次 compact，记录 before/after token 数（来自 agent.compact span attributes）
- 预期：`compacts.count === 1`，`compacts.totalTokensSaved > 0`

**TC-T2-05：metrics summary CLI 与 JSONL 数据一致性**
- 操作：`pegasus metrics summary --period 24h`
- 预期：输出与 `metrics.jsonl` 中对应时段数据吻合（人工比对抽查）

**TC-T2-06：metrics tokens --by model**
- 操作：使用 2 个不同模型各调用几次后查询
- 预期：输出按模型分组，各模型 token 统计正确

### B.4 Phase 3（Health）测试计划

**TC-T3-01：健康状态阈值判断（6 项）**
- 分别构造满足 healthy / degraded / critical 条件的 MetricRecord
- 预期：6 项检查 level 与预期匹配

**TC-T3-02：Overall 降级逻辑**
- 操作：1 项 degraded + 0 项 critical
- 预期：`overall === "degraded"`

**TC-T3-03：Overall critical 逻辑**
- 操作：1 项 critical
- 预期：`overall === "critical"`（优先于 degraded）

**TC-T3-04：health CLI 输出格式**
- 预期：6 项检查，每项含状态图标 + 当前值 + 阈值

**TC-T3-05：慢 LLM mock 响应**
- 操作：注入 P95 latency > 15s 的 mock LLM
- 预期：`pegasus health` 显示 LLM Latency P95 为 🔴 Critical

### B.5 测试覆盖目标

| 模块 | 目标覆盖率 | 关键路径 |
|------|-----------|---------|
| `src/telemetry/types.ts` | 100%（编译时验证） | — |
| `src/telemetry/collector.ts` | ≥ 85% | startTrace/endTrace/recordSpan |
| `src/telemetry/span.ts` (SpanWriter) | ≥ 90% | write/flush/close/rotate |
| `src/telemetry/trace-store.ts` | ≥ 80% | search/getTrace/slowest/formatTraceTree |
| `src/telemetry/health.ts`（Phase 3）| ≥ 90% | check/各项检查逻辑 |
| 修改的现有文件回归 | 100% | agent.ts/reflection.ts/pegasus.ts 修改点 |

### B.6 测试文件结构

```
tests/
└── telemetry/
    ├── span-writer.test.ts         # TC-T1-06 ~ TC-T1-14（buffer + 轮转）
    ├── collector.test.ts           # TC-T1-01 ~ TC-T1-05（span 正确性）
    ├── trace-store.test.ts         # TC-T1-15 ~ TC-T1-19（查询 + 容错）
    ├── metrics-aggregator.test.ts  # TC-T2-01 ~ TC-T2-04
    ├── metrics-query.test.ts       # TC-T2-05 ~ TC-T2-06
    ├── health.test.ts              # TC-T3-01 ~ TC-T3-05
    ├── integration.test.ts         # TC-T1-20 ~ TC-T1-22（非侵入性）
    └── fixtures/
        ├── sample-spans.jsonl      # 固定 span 数据（含已知树结构）
        └── sample-metrics.jsonl    # 固定 metrics 数据
```

**测试隔离约定：**
- 所有测试使用 `os.tmpdir()` + 随机子目录（`crypto.randomUUID()`）
- `afterEach` 清理临时目录
- 不碰 `~/.pegasus/` 任何文件

---

## Part C：设计审查意见

### C.1 架构方案（v2）确认 ✅

v2 方案经 Architect 确认通过，3 个偏差全部修正：

| 修正项 | v1 → v2 |
|--------|---------|
| 采集策略 | EventBus 订阅 → `_executeToolAsync()` 直接埋点（ToolExecutor.ts 不改） |
| traceId 管理 | 全局 activeTraceId → `AgentExecutionState.traceId`（per-agent，支持并发） |
| flush 策略 | 5s/100条 → 1s/10条 + `process.on('beforeExit')` 兜底 |

4 个改进建议也已落实（单一 telemetry_query tool、Memory kind 用 ToolContext.toolKind、日期后缀轮转、onLLMUsage 加可选 durationMs）。

### C.2 Phase 1 traceId 限制说明

子任务（subagent）在 Phase 1 使用独立 traceId（不与父 Agent 共享），跨子任务 trace 关联在 Phase 2 解决。这是合理的渐进策略，但意味着 Phase 1 的 `trace show` 无法展示涉及子任务的完整跨 Agent 链路。

**Phase 1 验收标准中应明确此限制**，避免误解。

### C.3 补充建议（已被 Dev 确认采纳）

1. ✅ `SpanWriter` 构造函数加 `flushIntervalMs` 参数（默认 1000，测试时可设 0）
2. ✅ `TraceQuery` 读取 JSONL 时对非法行 `logger.warn` + 跳过，不抛错
3. ✅ 测试全部使用 `os.tmpdir()` + 随机子目录，不碰 `~/.pegasus/`

---

*QA 报告 v2，基于 observability-design.md v2（Architect 已确认）。Dev 继续 Phase 1 剩余工作，QA 同步搭建测试框架。*
