# Pegasus Configuration Guide

Pegasus 支持两种配置方式：**配置文件（推荐）**和**环境变量**。

## 🎯 快速开始

### 方式 1: 配置文件（推荐）

```bash
# 1. 编辑默认配置文件
vim config.yml
# 修改 provider 和对应的 apiKey（可选）

# 2. （推荐）创建本地覆盖配置
cp config.yml config.local.yml
# 编辑 config.local.yml，只保留需要覆盖的字段

# 3. 运行
bun run dev
```

**提示**: `config.yml` 是项目默认配置,会提交到 git。`config.local.yml` 用于本地覆盖,不会提交到 git。

### 方式 2: 环境变量

```bash
# 仍然支持 .env 文件
cp .env.example .env
# 编辑 .env
bun run dev
```

## 📋 配置文件格式

### config.yml 结构

```yaml
llm:
  provider: openai  # openai | anthropic | openai-compatible

  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o-mini
      baseURL: null  # Optional: override API endpoint

    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
      model: claude-sonnet-4-20250514
      baseURL: null

    # For Ollama, LM Studio, etc.
    ollama:
      apiKey: dummy  # Most local models don't need a real key
      model: llama3.2:latest
      baseURL: http://localhost:11434/v1

  maxConcurrentCalls: 3
  timeout: 120  # seconds

agent:
  maxActiveTasks: 5
  maxConcurrentTools: 3
  maxCognitiveIterations: 10
  heartbeatInterval: 60

memory:
  dbPath: data/memory.db
  vectorDbPath: data/vectors

identity:
  personaPath: data/personas/default.json

system:
  logLevel: info  # debug | info | warn | error | silent
  dataDir: data
  logConsoleEnabled: false  # Enable console logging (default: false)
```

### 配置文件查找策略

Pegasus 采用**分层配置**模式：

1. **PEGASUS_CONFIG 环境变量**（如果设置）
2. **config.yml** (默认配置) → **config.local.yml** (本地覆盖,深度合并)
3. **config.yaml** → **config.local.yaml** (备选,深度合并)
4. 如果没有找到配置文件，回退到**环境变量模式**

**推荐使用 `.yml` 扩展名** (项目默认使用 config.yml)

**重要**: 不能同时存在 `config.yaml` 和 `config.yml`，也不能同时存在 `config.local.yaml` 和 `config.local.yml`。如果检测到冲突，系统会抛出错误提示你删除其中一个文件。

```bash
# ❌ 错误示例 - 会抛出错误
$ ls config*
config.yaml  config.yml  # 冲突！

# ✅ 正确示例 - 推荐使用 .yml
$ ls config*
config.yml  config.local.yml  # 正确（推荐）

# ✅ 也可以使用 .yaml
$ ls config*
config.yaml  config.local.yaml  # 正确（备选）
```

#### 深度合并示例

**config.yml** (基础配置):
```yaml
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o-mini
      apiKey: ${OPENAI_API_KEY}
      baseURL: https://api.openai.com/v1
  timeout: 120
memory:
  dbPath: data/memory.db
```

**config.local.yml** (本地覆盖):
```yaml
llm:
  provider: anthropic  # 覆盖 provider
  providers:
    anthropic:
      model: claude-sonnet-4  # 添加新配置
      apiKey: ${ANTHROPIC_API_KEY}
  timeout: 180  # 覆盖 timeout
```

**最终生效配置**:
```yaml
llm:
  provider: anthropic  # ← 来自 local
  providers:
    openai:  # ← 来自 base（保留）
      model: gpt-4o-mini
      apiKey: ${OPENAI_API_KEY}
      baseURL: https://api.openai.com/v1
    anthropic:  # ← 来自 local
      model: claude-sonnet-4
      apiKey: ${ANTHROPIC_API_KEY}
  timeout: 180  # ← 来自 local
memory:  # ← 来自 base（未覆盖）
  dbPath: data/memory.db
```

## 🔑 环境变量插值

配置文件支持 `${VAR_NAME}` 语法引用环境变量，并支持 bash 风格的默认值语法：

### 基础语法

```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}  # 引用环境变量
```

### Bash 风格默认值语法

配置文件支持以下 bash 风格的语法：

#### 1. `${VAR:-default}` - 使用默认值

如果环境变量未设置或为空，使用默认值：

```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY:-sk-default-key}
      model: ${OPENAI_MODEL:-gpt-4o-mini}
```

#### 2. `${VAR:=default}` - 设置并使用默认值

如果环境变量未设置或为空，使用默认值并设置到环境变量：

```yaml
llm:
  providers:
    openai:
      model: ${OPENAI_MODEL:=gpt-4o-mini}
```

#### 3. `${VAR:?error}` - 必需的环境变量

如果环境变量未设置或为空，抛出错误：

```yaml
llm:
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY:?API key is required}
```

#### 4. `${VAR:+alternate}` - 已设置时使用替代值

如果环境变量已设置，使用替代值：

```yaml
llm:
  providers:
    openai:
      baseURL: ${USE_PROXY:+https://proxy.example.com/v1}
```

### 实际使用示例

```yaml
llm:
  provider: ${LLM_PROVIDER:-openai}

  providers:
    openai:
      # 必需的 API key，未设置时报错
      apiKey: ${OPENAI_API_KEY:?OpenAI API key is required}
      # 可选的模型，默认使用 gpt-4o-mini
      model: ${OPENAI_MODEL:-gpt-4o-mini}
      # 可选的代理，设置 USE_PROXY 时才启用
      baseURL: ${USE_PROXY:+https://proxy.example.com/v1}

    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
      model: ${ANTHROPIC_MODEL:-claude-sonnet-4-20250514}

system:
  logLevel: ${LOG_LEVEL:-info}
```

### 优势

这样你可以：
- 配置文件提交到 git（不包含敏感信息）
- 敏感信息通过环境变量注入
- 为开发环境提供合理的默认值
- 强制要求某些关键配置必须设置

## 📊 配置优先级

从高到低：

1. **环境变量** （最高优先级）
   - `LLM_PROVIDER=anthropic` 覆盖配置文件中的所有设置

2. **config.local.yml**
   - 本地覆盖配置（不提交 git）

3. **config.yml**
   - 基础配置（提交 git）

4. **默认值**
   - Schema 中定义的默认值

### 示例

**config.yml**:
```yaml
llm:
  provider: openai
  providers:
    openai:
      model: gpt-4o-mini
```

**config.local.yml**:
```yaml
llm:
  providers:
    openai:
      model: gpt-4o  # 覆盖为 gpt-4o
```

```bash
# 环境变量覆盖（最高优先级）
export LLM_PROVIDER=anthropic
export ANTHROPIC_MODEL=claude-opus-4-20250514

bun run dev
# → 使用 anthropic provider + claude-opus-4-20250514
```

## 🎨 配置示例

### 示例 1: 开发环境（多 provider）

**config.yml** (团队共享,提交到 git):
```yaml
llm:
  provider: openai
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o-mini
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
      model: claude-sonnet-4-20250514
    ollama:
      model: llama3.2:latest
      baseURL: http://localhost:11434/v1
  maxConcurrentCalls: 3
```

**config.local.yml** (个人本地,不提交 git):
```yaml
# 本地开发时使用 Ollama
llm:
  provider: ollama
```

切换 provider：
```bash
# 临时测试 Anthropic
export LLM_PROVIDER=anthropic
bun run dev
```

### 示例 2: 生产环境

**config.yml**:
```yaml
llm:
  provider: anthropic
  providers:
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
      model: claude-sonnet-4-20250514
  maxConcurrentCalls: 10
  timeout: 180

agent:
  maxActiveTasks: 20
  maxConcurrentTools: 5

system:
  logLevel: warn
```

### 示例 3: 本地开发（Ollama）

**config.local.yml**:
```yaml
llm:
  provider: ollama
  providers:
    ollama:
      apiKey: dummy
      model: qwen2.5:latest
      baseURL: http://localhost:11434/v1

system:
  logLevel: debug
```

### 示例 4: OpenAI 代理

**config.yml**:
```yaml
llm:
  provider: openai
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o
      baseURL: https://your-proxy.com/v1
```

## 🔒 安全最佳实践

### ✅ 推荐做法

**分层配置 + 环境变量分离**：

**config.yml** (可以提交 git):
```yaml
llm:
  provider: openai
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}  # 引用环境变量
      model: gpt-4o-mini
```

**config.local.yml** (不提交 git):
```yaml
# 本地开发配置
llm:
  provider: ollama  # 覆盖为本地模型
```

**.env** (不提交 git):
```bash
OPENAI_API_KEY=sk-proj-actual-key-here
```

### ❌ 不推荐

```yaml
# 不要在配置文件中硬编码 API key
llm:
  providers:
    openai:
      apiKey: sk-proj-hardcoded-key  # ❌ 不要这样做
```

## 📖 完整配置选项

### LLM 配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `llm.provider` | string | `"openai"` | 活跃的 provider |
| `llm.providers.<name>.apiKey` | string | - | API key（支持插值） |
| `llm.providers.<name>.model` | string | - | 模型名称 |
| `llm.providers.<name>.baseURL` | string | null | 自定义 API endpoint |
| `llm.maxConcurrentCalls` | number | 3 | 最大并发调用数 |
| `llm.timeout` | number | 120 | 超时时间（秒） |

### Agent 配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `agent.maxActiveTasks` | number | 5 | 最大活跃任务数 |
| `agent.maxConcurrentTools` | number | 3 | 最大并发工具调用 |
| `agent.maxCognitiveIterations` | number | 10 | 最大认知循环次数 |
| `agent.heartbeatInterval` | number | 60 | 心跳间隔（秒） |

### Identity 配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `identity.personaPath` | string | `"data/personas/default.json"` | Persona 文件路径 |

### Memory 配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `memory.dbPath` | string | `"data/memory.db"` | SQLite 数据库路径 |
| `memory.vectorDbPath` | string | `"data/vectors"` | 向量数据库路径 |

### System 配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `system.logLevel` | string | `"info"` | 日志级别 (debug/info/warn/error/silent) |
| `system.dataDir` | string | `"data"` | 数据目录 |
| `system.logConsoleEnabled` | boolean | `false` | 启用控制台日志输出 |

**注意**: 文件日志永远启用，保存到 `{dataDir}/logs/pegasus.log`，无法禁用。

## 📝 日志配置

Pegasus 的日志系统永远将日志写入文件，并支持可选的控制台输出。

### 默认行为

- ✅ **文件日志**: 永远启用，无法禁用，保存到 `{dataDir}/logs/pegasus.log`
- ❌ **控制台日志**: 默认禁用，可以按需启用

### 启用控制台输出

**config.yml**:
```yaml
system:
  logLevel: info
  dataDir: data
  # 启用控制台输出（用于开发调试）
  logConsoleEnabled: true
```

**或通过环境变量**:
```bash
export PEGASUS_LOG_CONSOLE_ENABLED=true  # 启用控制台日志
```

### 日志特性

- **每日轮转**: 每天自动创建新的日志文件（格式：`pegasus.log.YYYY-MM-DD`）
- **大小轮转**: 当日志文件超过 10MB 时自动轮转
- **自动清理**: 自动删除 30 天前的旧日志文件
- **自动创建目录**: 如果日志目录不存在，会自动创建

### 日志格式

- **文件输出**: 始终是 JSON 格式
- **控制台输出**:
  - 开发环境: 彩色格式 (pino-pretty)
  - 生产环境: JSON 格式

### 示例配置

**开发环境（文件 + 控制台）**:
```yaml
system:
  logLevel: debug
  dataDir: data
  logConsoleEnabled: true   # 同时输出到控制台
```

**生产环境（仅文件）**:
```yaml
system:
  logLevel: info
  dataDir: /var/lib/pegasus
  # 仅文件日志，无控制台输出（默认）
```

更多详细信息，请参考 [日志文档](./logging.md)。

## 🔄 迁移指南

### 从环境变量迁移到配置文件

**之前（.env）**：
```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o-mini
```

**现在（config.yml + .env）**：

**config.yml**:
```yaml
llm:
  provider: openai
  providers:
    openai:
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o-mini
```

**.env**:
```bash
OPENAI_API_KEY=sk-proj-...
```

**优势**：
- 配置文件可以提交 git（无敏感信息）
- 团队成员共享配置
- 更清晰的结构
- 支持注释
- 支持本地覆盖（config.local.yml）

## 🚀 高级用法

### 多环境配置

```bash
# 开发环境 - 使用默认配置
vim config.yml
# 编辑基础配置

# 个人本地配置
cp config.yml config.local.yml
# 编辑本地覆盖配置

# 生产环境（通过环境变量指定）
export PEGASUS_CONFIG=/etc/pegasus/config.yml
```

### 动态切换 Provider

```bash
# 配置文件中定义所有 provider
# 运行时通过环境变量切换
export LLM_PROVIDER=anthropic
bun run dev

# 或者临时测试
LLM_PROVIDER=ollama bun run dev
```

### 团队协作最佳实践

1. **提交 `config.yml`** 到 git（基础配置）
2. 每个成员创建自己的 `config.local.yml`（本地覆盖）
3. **不提交** `config.local.yml` 和 `.env` 到 git
4. 敏感信息通过 `.env` 管理

**.gitignore**:
```
config.local.yml
config.local.yaml
.env
.env.local
```

## 🔍 调试配置

```bash
# 查看当前加载的配置
PEGASUS_LOG_LEVEL=debug bun run dev

# 日志会显示：
# INFO: loading_base_config path=config.yml
# INFO: loading_local_config_override path=config.local.yml
# INFO: merging_base_and_local_configs
# INFO: active_provider provider=openai model=gpt-4o-mini
```

## 📚 参考

- [默认配置文件](../config.yml)
- [环境变量配置](../.env.example)
- [LLM Provider 配置设计](./llm-provider-config.md)
- [配置 Schema 定义](../src/infra/config-schema.ts)

