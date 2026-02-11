# LLM Provider Configuration Design

## 设计理念

提供统一的抽象接口配置多个 LLM provider，每个 provider 可以独立配置 API key、model 和 baseURL。

## 核心特性

### 1. Provider-Specific Configuration

每个 provider 有独立的配置命名空间：

```bash
# OpenAI
OPENAI_API_KEY=...
OPENAI_MODEL=...
OPENAI_BASE_URL=...  # Optional

# Anthropic
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=...
ANTHROPIC_BASE_URL=...  # Optional
```

### 2. 智能默认值

- **baseURL**: 如果不设置，使用官方 API 地址
- **model**: 如果 provider-specific 不设置，使用全局 `LLM_MODEL`

### 3. 多 Provider 共存

可以同时配置多个 provider，通过 `LLM_PROVIDER` 切换：

```bash
LLM_PROVIDER=openai  # 改这里切换

OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o-mini

ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

### 4. OpenAI-Compatible 支持

使用 `LLM_BASE_URL` 配置 Ollama、LM Studio 等：

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.2:latest
```

## 配置优先级

以 OpenAI 为例：

```
OPENAI_MODEL > LLM_MODEL (fallback)
OPENAI_API_KEY > LLM_API_KEY (legacy)
OPENAI_BASE_URL > (官方 API - default)
```

## 实现细节

### 配置 Schema

```typescript
// Provider-specific config
ProviderConfigSchema = {
  apiKey: string | undefined,
  baseURL: string | undefined,
  model: string | undefined,
}

// LLM config
LLMConfigSchema = {
  provider: "openai" | "anthropic" | "openai-compatible",
  model: string,  // Global default
  openai: ProviderConfigSchema,
  anthropic: ProviderConfigSchema,
  baseURL: string | undefined,  // For openai-compatible
  ...
}
```

### Helper Function

```typescript
function getActiveProviderConfig(settings: Settings): {
  apiKey?: string;
  baseURL?: string;
  model: string;
}
```

根据 `settings.llm.provider` 返回当前 provider 的配置，自动处理 fallback。

## 使用示例

### Example 1: OpenAI (简单)

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
```

结果：
- Model: `gpt-4o-mini` (默认值)
- BaseURL: 官方 API

### Example 2: Anthropic (自定义 model)

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-20250514
```

### Example 3: OpenAI + 自定义 baseURL

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=your-key
OPENAI_BASE_URL=https://your-proxy.com/v1
```

### Example 4: Ollama (本地)

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.2:latest
```

### Example 5: 多 Provider 快速切换

```bash
# 配置多个
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...

# 只需改这一行切换
LLM_PROVIDER=openai  # or anthropic
```

## 优势

### vs 之前的设计

**之前**:
```bash
LLM_PROVIDER=openai
LLM_API_KEY=...
LLM_MODEL=...
LLM_BASE_URL=...  # 不清楚是给哪个 provider
```

**现在**:
```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=...
OPENAI_BASE_URL=...  # 明确是 OpenAI 的
```

### 好处

1. **清晰性** - 每个配置项明确属于哪个 provider
2. **灵活性** - 可以同时配置多个 provider，快速切换
3. **扩展性** - 添加新 provider 不影响现有配置
4. **向后兼容** - `LLM_API_KEY` 仍然可用作 fallback
5. **智能默认** - baseURL 默认官方地址，model 有全局 fallback

## Migration Guide

### 从旧版本迁移

如果你之前使用：

```bash
LLM_PROVIDER=openai
LLM_API_KEY=sk-proj-...
LLM_MODEL=gpt-4o
```

现在推荐（但旧的仍然有效）：

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o
```

或者保持旧配置不变（通过 fallback 仍然有效）。

## 未来扩展

可以轻松添加新 provider：

```typescript
// 1. Add to provider enum
provider: "openai" | "anthropic" | "gemini" | ...

// 2. Add config namespace
gemini: ProviderConfigSchema.default({})

// 3. Update loader
gemini: {
  apiKey: env["GEMINI_API_KEY"] || env["LLM_API_KEY"],
  baseURL: env["GEMINI_BASE_URL"],
  model: env["GEMINI_MODEL"],
}
```

用户配置：

```bash
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-pro
```
