# Vision Support

> Source code: `src/media/`

## Core Idea

Pegasus can receive, store, and reason about images. Images flow through a pipeline: Channel receives → ImageManager compresses and stores → Message carries references → LLM sees images via lazy hydration.

The key design principle: **base64 data is transient**. It never enters session persistence (JSONL) or crosses thread boundaries. Images are stored as files by ImageManager, and base64 is injected on-demand right before LLM calls.

## Architecture

```
Channel (Telegram photo / CLI @path)
    │ raw image buffer
    ▼
ImageManager.store()
    │ sharp compress → SHA-256 hash → dedup → write file → SQLite metadata
    ▼
InboundMessage { text, images: [{ id, mimeType }] }
    │
    ▼
MainAgent._handleMessage()
    │ constructs Message { content, images: [{ id, mimeType }] }
    │
    ├─► SessionStore.append() — stores { id, mimeType } only, never base64
    │
    ├─► Before LLM call: hydrateImages(messages, keepLastN)
    │     │ recent N turns → inject base64 from ImageManager
    │     │ older turns → leave as ref
    │     └─► returns NEW array (sessionMessages not mutated)
    │
    ├─► toPiAiContext()
    │     │ ImageAttachment with data → pi-ai image content block
    │     └─ ImageAttachment without data → text "[img://id — use image_read]"
    │
    └─► LLM can call image_read tool to view older/pruned images

Tool Image Flow (Task Agent):
    Tool (read_file, browser_screenshot, image_read)
        │ detects image / captures screenshot
        ▼
    image-helpers.readImageFile() or direct context.storeImage()
        │ buffer → ToolContext.storeImage(buffer, mime, source)
        ▼
    ImageManager.store() — compress, dedup, persist
        │ returns { id, mimeType }
        ▼
    ToolResult { images: [{ id, mimeType, data }] }
        │ pushed to task context.messages
        ▼
    notify → TaskNotification { imageRefs } (incremental, new images only)
    completed → _compileResult() { imageRefs } (all images from task)
```

## Components

### ImageManager (`src/media/image-manager.ts`)

Single owner of image storage. Only component that writes to `data/media/`.

- **store()**: compress → hash → dedup → write file → SQLite → return ImageRef
- **read()**: return base64 by ID (for hydration and image_read tool)
- **close()**: release SQLite connection (called by MainAgent.stop())

Storage: `data/media/images/{hash12}.{ext}` + `data/media/media.db` (SQLite metadata).

### Image Resize (`src/media/image-resize.ts`)

Sharp wrapper with OpenClaw-inspired compression algorithm:
1. If image fits within limits → return original
2. Try size grid × quality steps (descending)
3. First result under maxBytes wins
4. Graceful fallback when sharp is unavailable

### Image Hydration (`src/media/image-prune.ts`)

`hydrateImages()` injects base64 data into recent messages before LLM calls:
- Counts assistant messages backwards to find turn boundary
- Messages within last N turns get base64 injected
- Returns new array — never mutates input
- MainAgent caches base64 reads to avoid repeated file I/O

### image_read Tool (`src/tools/builtins/image-tools.ts`)

Allows LLM to re-read pruned images. Filesystem-only (no SQLite) — scans `images/{id}.*`.
Registered in all tool collections (mainAgent, allTask, explore, plan).

### Image Helpers (`src/media/image-helpers.ts`)

Shared utilities for image detection and reading across tools:
- `isImageFile()` / `extToMime()` — extension-based image detection and MIME mapping
- `readImageFile()` — reads image from disk, stores via `context.storeImage`, returns ToolResult with image data

Used by: `read_file` (image detection branch), `image_read` (file path mode), `browser_screenshot` (after capture).

### ToolContext.storeImage (`src/tools/types.ts`)

Callback injected into ToolContext by Agent/MainAgent. Allows any tool to persist images through ImageManager without direct dependency:
```typescript
storeImage?: (buffer: Buffer, mimeType: string, source: string) => Promise<{ id: string; mimeType: string }>
```
Agent resolves this from either an injected callback (MainAgent path) or a self-provisioned ImageManager.

## Message Model

```typescript
interface Message {
  content: string;                    // text, always string
  images?: ImageAttachment[];         // optional, separate from content
  // ... other fields unchanged
}

interface ImageAttachment {
  id: string;           // SHA-256 first 12 hex
  mimeType: string;
  data?: string;        // base64 — transient, never persisted
}
```

**Why `images` is a separate field (not ContentPart[])**:
Pegasus has ~15 places that access `msg.content` as a string. A `string | ContentPart[]` union type would require modifying every access point — high risk, high effort. The separate `images` field achieves zero breaking changes.

## Channel Integration

- **Telegram**: `message:photo` handler downloads largest resolution, stores via StoreImageFn callback
- **CLI**: `@/path/to/image.ext` syntax detected by regex, file loaded and stored

Adapters receive `StoreImageFn` callback (not ImageManager instance) for decoupling. When vision is disabled, callback is undefined and all image handling is skipped.

## Token Estimation

Each hydrated image adds ~1600 tokens (conservative, based on Claude's image token calculation). Token estimation counts images within the hydration window (last N turns) to prevent compact trigger miscalculation.

## Configuration

```yaml
vision:
  enabled: true              # master switch
  keepLastNTurns: 5          # hydrate images from last N turns
  maxDimensionPx: 1200       # max image side after resize
  maxImageBytes: 5242880     # 5MB per image (API limit)
```

## Task Agent Image Passing

Images flow between Task Agent and MainAgent via structured `imageRefs` in TaskNotification:

1. **Mid-task notify**: Agent collects image refs from new messages since the last notify (incremental — avoids re-sending all historical images). Sends `TaskNotification { type: "notify", imageRefs }`.
2. **Task completion**: `_compileResult()` scans ALL task messages to collect every image ref. Sends `TaskNotification { type: "completed", imageRefs }`.
3. **MainAgent receives** `imageRefs` and hydrates them into its own context so the LLM can see task-produced images.

Tools produce images via `ToolContext.storeImage` → ImageManager → `ToolResult.images` → `context.messages`. The `image_read` tool is also available for the task LLM to re-read any stored image by ID.

## What Does NOT Change

- TaskFSM, EventBus, cognitive pipeline, memory system — all unchanged
- PostTaskReflector intentionally ignores images (does memory extraction, not image analysis)

## Deferred (Phase 2)

- MCP image passthrough (Worker thread write access needed)
- Image GC (cleanup unreferenced images)
- Audio/video support (data/media/ structure ready)
- Image in OutboundMessage (agent sending images to user)
