# TUI — Terminal User Interface

> Source code: `src/tui/`

## Overview

Pegasus includes a terminal dashboard built with **Solid.js** and **@opentui/solid**. It provides a real-time view of agent activity: chat messages, subagent status, tool usage, token budget, and channel connections — all rendered in the terminal.

## Architecture

```
src/tui/
├── app.tsx              # Root component (responsive layout)
├── main.tsx             # Render entry point (renderApp)
├── bridge.ts            # AppStats → Solid store polling bridge
├── store.ts             # Reactive store (chat messages, stats, callbacks)
├── theme.tsx            # Color theme constants
├── mock-data.tsx        # Mock AppStats for development mode
├── clipboard.ts         # OSC 52 clipboard support
│
├── components/
│   ├── top-bar.tsx      # Persona, uptime, LLM call count, status dot
│   ├── input-bar.tsx    # Text input with submit (Enter) and hints
│   ├── tab-bar.tsx      # Tab switcher for narrow terminals
│   └── section-header.tsx  # Reusable section header with icon
│
├── panels/
│   ├── chat-panel.tsx   # Chat messages (user + assistant replies)
│   ├── ops-panel.tsx    # Subagents, Memory, Tools
│   └── metrics-panel.tsx # Model/Tokens, Budget bar, Channels
│
└── hooks/
    └── use-terminal-size.ts  # Layout mode computation (columns vs tabs)
```

### Component Tree

```
App
├── TopBar          — persona name, uptime, LLM calls, status indicator
├── TabBar          — (narrow mode only) Ctrl+1/2/3 tab switcher
├── Body
│   ├── ChatPanel   — scrollable chat history
│   ├── OpsPanel    — Subagents / Memory / Tools sections
│   └── MetricsPanel — Model info / Budget bar / Channels
└── InputBar        — text input with Enter to submit
```

## Responsive Layout

Layout adapts to terminal width:

| Width | Mode | Layout |
|-------|------|--------|
| ≥ 120 columns | `columns` | Three-column: Chat │ Ops │ Metrics |
| < 120 columns | `tabs` | Single panel with TabBar switcher |

In **columns mode**, fixed widths: Ops = 30 cols, Metrics = 28 cols, Chat = remaining.

In **tabs mode**, Ctrl+1/2/3 switches between Chat, Ops, and Metrics panels.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Submit message |
| `Ctrl+1` | Switch to Chat tab (tabs mode) |
| `Ctrl+2` | Switch to Ops tab (tabs mode) |
| `Ctrl+3` | Switch to Metrics tab (tabs mode) |
| `Ctrl+C` (×2) | Exit (first press warns, second within 2s exits) |

## Stats Bridge

The TUI displays live system statistics via a polling bridge:

```
AppStats (plain mutable object, owned by PegasusApp)
    │
    │  500ms setInterval
    │  structuredClone(appStats)
    ▼
Solid store (reconcile → fine-grained reactivity)
    │
    │  only changed fields trigger re-render
    ▼
TUI Panels (TopBar, OpsPanel, MetricsPanel)
```

**Why polling, not events**: AppStats is a passive read-only container. A single LLM call updates 4-5 fields. Polling at 500ms is imperceptible for a terminal UI refreshing at ~2 fps, and avoids coupling AppStats to any UI framework.

The bridge (`src/tui/bridge.ts`) calls `structuredClone()` to snapshot the stats object, then feeds it into Solid's `reconcile()` which performs structural diffing — only changed nodes trigger re-renders.

## Message Flow

Chat messages follow a separate path from stats:

```
User input → InputBar → sendInput() → TuiAdapter → agent.send(InboundMessage)
Agent reply → TuiAdapter.deliver(OutboundMessage) → addMessage() → ChatPanel
```

The TUI acts as a `ChannelAdapter`. Messages go directly into the reactive store — they do not flow through AppStats.

## Entry Points

| Command | Mode | Description |
|---------|------|-------------|
| `bun run tui` | Production | Full PegasusApp + TUI rendering |
| `bun run tui:dev` | Development | Standalone TUI with mock data (no agent) |

Development mode (`tui:dev`) uses `src/tui/mock-data.tsx` to provide static AppStats, allowing UI iteration without starting the agent.

## Stats Store

The reactive store (`src/tui/store.ts`) maintains two independent data streams:

1. **Chat messages** — `ChatMessage[]` array, updated by TuiAdapter
2. **AppStats snapshot** — updated by the stats bridge every 500ms

Session messages are loaded at startup from the agent's in-memory `sessionMessages` via `loadMessages()`, which converts `Message[]` to `ChatMessage[]` (filtering out system-injected messages like memory index, compact summaries, and task notifications).
