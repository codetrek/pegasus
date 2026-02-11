# Pegasus Configuration Guide

Pegasus 支持两种配置方式：**配置文件（推荐）**和**环境变量**。

## 🎯 快速开始

### 方式 1: 配置文件（推荐）

```bash
# 1. 复制配置模板
cp config.example.json config.json

# 2. 编辑 config.json
# 修改 provider 和对应的 apiKey

# 3. 运行
bun run dev
```

### 方式 2: 环境变量

```bash
# 仍然支持 .env 文件
cp .env.example .env
# 编辑 .env
bun run dev
```

## 📋 配置文件格式

### config.json 结构

```json
{
  "llm": {
    "provider": "openai",
    "providers": {
      "openai": {
        "apiKey": "${OPENAI_API_KEY}",
        "model": "gpt-4o-mini",
        "baseURL": null
      },
      "anthropic": {
        "apiKey": "${ANTHROPIC_API_KEY}",
        "model": "claude-sonnet-4-20250514"
      },
      "ollama": {
        "apiKey": "dummy",
        "model": "llama3.2:latest",
        "baseURL": "http://localhost:11434/v1"
      }
    }
  }
}
```

### 支持的配置文件路径

按优先级顺序查找：

1. 命令行指定: `--config path/to/config.json`
2. `config.json` （当前目录）
3. `config.local.json` （本地覆盖，不提交git）
4. `.pegasus.json` （隐藏配置）
5. 环境变量（fallback）

## 🔑 环境变量插值

配置文件支持 `${VAR_NAME}` 语法引用环境变量：

```json
{
  "llm": {
    "providers": {
      "openai": {
        "apiKey": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

这样你可以：
- 配置文件提交到 git（不包含敏感信息）
- 敏感信息通过环境变量注入

## 📊 配置优先级

从高到低：

1. **环境变量** （最高优先级）
   - `LLM_PROVIDER=anthropic` 覆盖配置文件

2. **配置文件**
   - `config.json` 或 `config.local.json`

3. **默认值**
   - Schema 中定义的默认值

### 示例

```json
// config.json
{
  "llm": {
    "provider": "openai",
    "providers": {
      "openai": { "model": "gpt-4o-mini" }
    }
  }
}
```

```bash
# 环境变量覆盖
export LLM_PROVIDER=anthropic
export ANTHROPIC_MODEL=claude-opus-4-20250514

bun run dev
# → 使用 anthropic provider + claude-opus-4-20250514
```

## 🎨 配置示例

### 示例 1: 开发环境（多 provider）

```json
{
  "llm": {
    "provider": "openai",
    "providers": {
      "openai": {
        "apiKey": "${OPENAI_API_KEY}",
        "model": "gpt-4o-mini"
      },
      "anthropic": {
        "apiKey": "${ANTHROPIC_API_KEY}",
        "model": "claude-sonnet-4-20250514"
      },
      "ollama": {
        "model": "llama3.2:latest",
        "baseURL": "http://localhost:11434/v1"
      }
    }
  }
}
```

切换 provider：
```bash
export LLM_PROVIDER=ollama
bun run dev
```

### 示例 2: 生产环境（单 provider）

```json
{
  "llm": {
    "provider": "anthropic",
    "providers": {
      "anthropic": {
        "apiKey": "${ANTHROPIC_API_KEY}",
        "model": "claude-sonnet-4-20250514",
        "baseURL": null
      }
    },
    "maxConcurrentCalls": 10,
    "timeout": 180
  },
  "agent": {
    "maxActiveTasks": 20,
    "maxConcurrentTools": 5
  },
  "system": {
    "logLevel": "warn"
  }
}
```

### 示例 3: 本地开发（Ollama）

```json
{
  "llm": {
    "provider": "ollama",
    "providers": {
      "ollama": {
        "apiKey": "dummy",
        "model": "qwen2.5:latest",
        "baseURL": "http://localhost:11434/v1"
      }
    }
  },
  "system": {
    "logLevel": "debug"
  }
}
```

### 示例 4: OpenAI 代理

```json
{
  "llm": {
    "provider": "openai",
    "providers": {
      "openai": {
        "apiKey": "${OPENAI_API_KEY}",
        "model": "gpt-4o",
        "baseURL": "https://your-proxy.com/v1"
      }
    }
  }
}
```

## 🔒 安全最佳实践

### ✅ 推荐做法

**配置文件 + 环境变量分离**：

```json
// config.json (可以提交 git)
{
  "llm": {
    "provider": "openai",
    "providers": {
      "openai": {
        "apiKey": "${OPENAI_API_KEY}",  // 引用环境变量
        "model": "gpt-4o-mini"
      }
    }
  }
}
```

```bash
# .env (不提交 git)
OPENAI_API_KEY=sk-proj-actual-key-here
```

### ❌ 不推荐

```json
// 不要在配置文件中硬编码 API key
{
  "llm": {
    "providers": {
      "openai": {
        "apiKey": "sk-proj-hardcoded-key"  // ❌ 不要这样做
      }
    }
  }
}
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

## 🔄 迁移指南

### 从环境变量迁移到配置文件

**之前（.env）**：
```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o-mini
```

**现在（config.json + .env）**：
```json
{
  "llm": {
    "provider": "openai",
    "providers": {
      "openai": {
        "apiKey": "${OPENAI_API_KEY}",
        "model": "gpt-4o-mini"
      }
    }
  }
}
```

```bash
# .env
OPENAI_API_KEY=sk-proj-...
```

**优势**：
- 配置文件可以提交 git（无敏感信息）
- 团队成员共享配置
- 更清晰的结构
- 支持注释（JSON5/JSONC）

## 🚀 高级用法

### 多环境配置

```bash
# 开发环境
cp config.example.json config.local.json
# 编辑 config.local.json

# 生产环境
cp config.example.json config.production.json
# 通过环境变量指定
export PEGASUS_CONFIG=config.production.json
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

### 团队协作

1. **提交 `config.example.json`** 到 git
2. 每个成员创建自己的 `config.local.json`
3. **不提交** `config.local.json` 到 git
4. 敏感信息通过 `.env` 管理

## 🔍 调试配置

```bash
# 查看当前加载的配置
PEGASUS_LOG_LEVEL=debug bun run dev

# 日志会显示：
# INFO: loading_config_file path=config.json
# INFO: active_provider provider=openai model=gpt-4o-mini
```

## 📚 参考

- [配置文件示例](../config.example.json)
- [环境变量配置](./.env.example)
- [LLM Provider 配置设计](./llm-provider-config.md)
