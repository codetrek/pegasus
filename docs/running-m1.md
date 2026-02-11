# 🚀 运行 M1：CLI 对话

本文档说明如何配置和运行 Pegasus CLI 进行对话。

## 前置要求

**选择以下任一选项：**

1. **云端 API** — OpenAI 或 Anthropic API Key
   - OpenAI: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
   - Anthropic: [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)

2. **本地模型** — Ollama、LM Studio 等（无需 API key）
   - [Ollama](https://ollama.com/) - 推荐，易用
   - [LM Studio](https://lmstudio.ai/) - GUI 界面
   - 其他 OpenAI-compatible 服务

3. Bun 运行时（已安装）

## 快速开始

### 选项 1: 使用 OpenAI（推荐，性价比高）

```bash
# 1. 复制配置模板
cp .env.example .env

# 2. 编辑 .env 文件
# LLM_PROVIDER=openai
# LLM_API_KEY=sk-proj-your-key-here
# LLM_MODEL=gpt-4o-mini

# 3. 启动
bun run dev
```

### 选项 2: 使用本地 Ollama（免费，无需 API key）

```bash
# 1. 安装并启动 Ollama
# macOS/Linux: brew install ollama && ollama serve
# 或访问 https://ollama.com/download

# 2. 拉取模型
ollama pull llama3.2

# 3. 配置 .env
# LLM_PROVIDER=openai-compatible
# LLM_BASE_URL=http://localhost:11434/v1
# LLM_MODEL=llama3.2:latest
# LLM_API_KEY=dummy

# 4. 启动
bun run dev
```

### 选项 3: 使用 Anthropic Claude

```bash
# 1. 配置 .env
# LLM_PROVIDER=anthropic
# LLM_API_KEY=sk-ant-api03-your-key-here
# LLM_MODEL=claude-sonnet-4-20250514

# 2. 启动
bun run dev
```

你会看到欢迎界面：

```
╔══════════════════════════════════════╗
║          🚀 Pegasus CLI              ║
╚══════════════════════════════════════╝
  Persona: Pegasus (intelligent digital employee)
  Type /help for commands, /exit to quit

>
```

### 3. 开始对话

```bash
> 你好
  Pegasus: 你好！我是 Pegasus，很高兴认识你。有什么我可以帮你的吗？

> 帮我想一个项目名
  Pegasus: [根据 persona 风格生成回复...]

> /exit
👋 Goodbye!
```

## 可用命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/exit` 或 `/quit` | 退出 CLI |

## 配置说明

### 默认配置（开箱即用）

以下配置有合理的默认值，无需在 `.env` 中设置：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `LLM_PROVIDER` | `openai` | LLM 提供商 |
| `LLM_MODEL` | `gpt-4o-mini` | 默认模型（性价比高） |
| `IDENTITY_PERSONA_PATH` | `data/personas/default.json` | 默认人格配置 |
| `AGENT_MAX_ACTIVE_TASKS` | `5` | 最大并发任务数 |
| `PEGASUS_LOG_LEVEL` | `info` | 日志级别 |

### 支持的 LLM Providers

| Provider | 配置 | 说明 |
|----------|------|------|
| **OpenAI** | `LLM_PROVIDER=openai` | GPT-4o, GPT-4o-mini 等 |
| **Anthropic** | `LLM_PROVIDER=anthropic` | Claude Sonnet 4, Opus 4 等 |
| **Ollama** | `LLM_PROVIDER=openai-compatible`<br>`LLM_BASE_URL=http://localhost:11434/v1` | 本地运行，免费 |
| **LM Studio** | `LLM_PROVIDER=openai-compatible`<br>`LLM_BASE_URL=http://localhost:1234/v1` | 本地运行，GUI 界面 |
| **Together AI** | `LLM_PROVIDER=openai-compatible`<br>`LLM_BASE_URL=https://api.together.xyz/v1` | 开源模型托管 |
| **任何 OpenAI-compatible** | `LLM_PROVIDER=openai-compatible`<br>`LLM_BASE_URL=your-url` | vLLM, FastChat 等 |

### 自定义配置

编辑 `.env` 文件自定义配置：

```bash
# 使用更强大的 OpenAI 模型
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
LLM_API_KEY=sk-proj-...

# 使用 Claude Opus（最强但最贵）
LLM_PROVIDER=anthropic
LLM_MODEL=claude-opus-4-20250514
LLM_API_KEY=sk-ant-...

# 使用本地 Ollama（免费）
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5:latest
LLM_API_KEY=dummy

# 使用自定义 persona
IDENTITY_PERSONA_PATH=data/personas/my-custom.json

# 调试模式（显示详细日志）
PEGASUS_LOG_LEVEL=debug
```

### 自定义 Persona

创建自己的 persona 配置文件：

```json
// data/personas/my-assistant.json
{
  "name": "Alice",
  "role": "helpful assistant",
  "personality": ["friendly", "patient", "detail-oriented"],
  "style": "Professional yet warm. Uses clear examples.",
  "values": ["accuracy", "clarity", "empathy"],
  "background": "Alice is designed to help users with technical questions."
}
```

然后在 `.env` 中引用：

```bash
IDENTITY_PERSONA_PATH=data/personas/my-assistant.json
```

## 故障排除

### 问题：CLI 卡住不响应

**原因**：可能在等待 LLM 响应或遇到网络问题。

**解决**：
1. 检查网络连接
2. 验证 API key 是否有效
3. 查看日志输出（设置 `PEGASUS_LOG_LEVEL=debug`）
4. 按 `Ctrl+C` 中断，重新启动

### 问题：API Key 未设置

**错误信息**：
```
Error: API key is required for provider: openai
```

**解决**：
```bash
# 确保 .env 文件存在且包含 API key
cat .env | grep LLM_API_KEY

# 如果没有，创建 .env 文件
cat > .env << EOF
LLM_PROVIDER=openai
LLM_API_KEY=your-key-here
LLM_MODEL=gpt-4o-mini
EOF
```

**使用本地模型无需 API key**：
```bash
# Ollama 配置（无需真实 API key）
cat > .env << EOF
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3.2:latest
LLM_API_KEY=dummy
EOF
```

### 问题：`data/personas/default.json` 不存在

**错误信息**：
```
Error: ENOENT: no such file or directory
```

**解决**：
这个文件应该在版本控制中。如果缺失，检查 git 状态：

```bash
git status data/personas/
```

### 问题：API 配额不足

**错误信息**：
```
Error: Rate limit exceeded
```

**解决**：
1. 检查 [Anthropic Console](https://console.anthropic.com/settings/limits) 配额
2. 升级计划或等待配额重置
3. 临时使用 GPT（需要实现 OpenAI provider）

## 测试验证

### 验证配置加载

```bash
# 运行配置测试
bun test tests/unit/infra.test.ts
```

### 验证 Persona 加载

```bash
# 运行身份系统测试
bun test tests/unit/identity.test.ts
```

### 验证完整流程

```bash
# 运行集成测试（不需要真实 API key）
bun test tests/integration/agent-lifecycle.test.ts
```

## 架构说明

CLI 的执行流程：

```
startCLI()
  ↓
1. 加载配置 (getSettings())
2. 加载 persona (loadPersona())
3. 创建 LLM model (createAnthropic())
4. 创建 Agent({ model, persona })
5. 启动 Agent (agent.start())
  ↓
用户输入 → agent.submit(text) → TaskFSM 认知循环
  ↓
PERCEIVING → THINKING → PLANNING → ACTING → REFLECTING
  ↓
agent.waitForTask(id) → 提取 response → 显示给用户
```

## 下一步

- **M2: 有记忆** — 实现对话历史记录和检索
- **M3: 能行动** — 集成 MCP 工具调用能力
- **M4: 会思考** — 增强复杂任务分解能力

## 相关文档

- [Architecture](../docs/architecture.md) - 系统架构总览
- [M1 Plan](../docs/plans/m1-plan.md) - M1 实现计划
- [Identity System](../src/identity/) - 身份系统代码
- [Cognitive Processors](../src/cognitive/) - 认知处理器
