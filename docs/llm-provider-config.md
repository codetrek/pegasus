# LLM Provider Configuration

## Overview

Pegasus provides a unified abstraction for configuring multiple LLM providers. Each provider can have independent configuration for API key, model, and base URL.

## Core Features

### 1. Provider-Specific Configuration

Each provider has its own configuration namespace:

```bash
# OpenAI
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1  # Optional

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4
ANTHROPIC_BASE_URL=https://api.anthropic.com  # Optional
```

### 2. Smart Defaults

- **baseURL**: Uses official API endpoint if not specified
- **model**: Falls back to global `LLM_MODEL` if provider-specific model not set

### 3. Multi-Provider Support

Configure multiple providers simultaneously and switch between them via `LLM_PROVIDER`:

```bash
LLM_PROVIDER=openai  # Switch provider here

OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o-mini

ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4
```

### 4. OpenAI-Compatible Endpoints

Support for Ollama, LM Studio, and other OpenAI-compatible services:

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.2:latest
```

## Configuration Priority

For OpenAI provider:

```
OPENAI_MODEL > LLM_MODEL (fallback)
OPENAI_API_KEY > LLM_API_KEY (legacy fallback)
OPENAI_BASE_URL > (official API endpoint as default)
```

## Configuration Schema

### Provider Config

```typescript
ProviderConfigSchema = {
  apiKey: string | undefined,
  baseURL: string | undefined,
  model: string | undefined,
}
```

### LLM Config

```typescript
LLMConfigSchema = {
  provider: "openai" | "anthropic" | "openai-compatible",
  model: string,  // Global default
  openai: ProviderConfigSchema,
  anthropic: ProviderConfigSchema,
  baseURL: string | undefined,  // For openai-compatible
  maxConcurrentCalls: number,
  timeout: number,
}
```

## Helper Function

```typescript
function getActiveProviderConfig(settings: Settings): {
  apiKey?: string;
  baseURL?: string;
  model: string;
}
```

Returns configuration for the active provider based on `settings.llm.provider`, automatically handling fallbacks.

## Usage Examples

### Example 1: OpenAI (Simple)

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
```

Result:
- Model: `gpt-4o-mini` (default)
- BaseURL: Official OpenAI API

### Example 2: Anthropic (Custom Model)

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4
```

### Example 3: OpenAI with Proxy

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=your-key
OPENAI_BASE_URL=https://your-proxy.com/v1
```

### Example 4: Ollama (Local)

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.2:latest
```

### Example 5: Quick Provider Switching

```bash
# Configure multiple providers
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-...

# Switch by changing this line only
LLM_PROVIDER=openai  # or anthropic
```

## Advantages

### Comparison with Generic Configuration

**Before (Generic)**:
```bash
LLM_PROVIDER=openai
LLM_API_KEY=...
LLM_MODEL=...
LLM_BASE_URL=...  # Unclear which provider this is for
```

**Now (Provider-Specific)**:
```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=...
OPENAI_BASE_URL=...  # Clearly for OpenAI
```

### Benefits

1. **Clarity** - Each configuration explicitly belongs to a specific provider
2. **Flexibility** - Configure multiple providers and switch between them easily
3. **Extensibility** - Adding new providers doesn't affect existing configuration
4. **Backward Compatibility** - `LLM_API_KEY` still works as fallback
5. **Smart Defaults** - BaseURL defaults to official endpoint, model has global fallback

## Migration Guide

### From Previous Version

If you previously used:

```bash
LLM_PROVIDER=openai
LLM_API_KEY=sk-proj-...
LLM_MODEL=gpt-4o
```

Now recommended (but old format still works):

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o
```

Legacy configuration continues to work through fallback mechanism.

## Extending with New Providers

Adding a new provider is straightforward:

**1. Update Schema**:
```typescript
// Add to provider enum
provider: "openai" | "anthropic" | "gemini" | ...

// Add config namespace
gemini: ProviderConfigSchema.default({})
```

**2. Update Config Loader**:
```typescript
gemini: {
  apiKey: env["GEMINI_API_KEY"] || env["LLM_API_KEY"],
  baseURL: env["GEMINI_BASE_URL"],
  model: env["GEMINI_MODEL"],
}
```

**3. User Configuration**:
```bash
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-pro
```

## Environment Variables Reference

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_PROVIDER` | Active provider | `openai` |
| `LLM_MODEL` | Global model fallback | `gpt-4o-mini` |
| `LLM_BASE_URL` | Base URL for openai-compatible | - |
| `OPENAI_API_KEY` | OpenAI API key | - |
| `OPENAI_MODEL` | OpenAI model | Uses `LLM_MODEL` |
| `OPENAI_BASE_URL` | OpenAI API endpoint | Official API |
| `ANTHROPIC_API_KEY` | Anthropic API key | - |
| `ANTHROPIC_MODEL` | Anthropic model | Uses `LLM_MODEL` |
| `ANTHROPIC_BASE_URL` | Anthropic API endpoint | Official API |
| `LLM_MAX_CONCURRENT_CALLS` | Max concurrent requests | `3` |
| `LLM_TIMEOUT` | Request timeout (seconds) | `120` |
