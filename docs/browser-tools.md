# Browser Tools

> Source: `src/tools/browser/`

## 1. Positioning

Browser Tools give the Pegasus Agent the ability to operate a real web browser —
navigating pages, filling forms, clicking buttons, extracting information, and
completing multi-step web workflows (login, checkout, data collection, etc.).

Without browser tools, the Agent is limited to raw HTTP requests via
`web_fetch`, which cannot handle JavaScript-rendered pages, cookie-based
sessions, or interactive UI flows. Browser Tools bridge that gap: they turn the
Agent into a user that can see and interact with any web page.

---

## 2. Design Decisions

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| **Browser library** | Playwright | Puppeteer, Selenium | Built-in ARIA tree snapshot API, first-class cross-browser support, validated by OpenClaw and Playwright MCP projects |
| **Runtime mode** | Host-native first, headless off by default | Docker sandbox | MVP priority is delivery speed; headless defaults to `false` so operators can observe browser actions; sandboxing can be layered on later without changing the tool interface |
| **Tool granularity** | Multiple fine-grained tools | Single `browser` tool with an `action` parameter | Consistent with existing patterns (`memory_read`/`memory_write`, `bg_run`/`bg_stop`); each tool has a clear Zod schema and description |
| **Page understanding** | ARIA snapshot (text) | Raw DOM/HTML, screenshot + multimodal vision | Token-efficient (~10-50× smaller than DOM); no changes needed to `Message` types; proven effective in OpenClaw and Playwright MCP |
| **Element reference** | `ref` numbering (`e1`, `e2`, …) | CSS selector, XPath | 2 tokens vs 20+; LLM-friendly — the model says "click e3" instead of writing a fragile selector |
| **Lifecycle** | Agent-level singleton, lazy launch, persistent profile at `{homeDir}/browser/` | Per-task instance, global eager launch | Shares browser session across tool calls (cookies, login state persist); avoids launching a browser that may never be used; persistent profile survives restarts |
| **Large page handling** | `maxNodes` truncation + compact mode | Unlimited output, viewport-only clipping | Prevents token explosion while preserving page structure; the Agent can request a deeper snapshot of a specific subtree if needed |
| **Security** | URL scheme allowlist (`http`, `https`) | Full SSRF prevention (IP range checks, DNS rebinding protection) | V1 baseline protection; stronger defenses planned for later without breaking the tool contract |

---

## 3. Why ARIA Snapshots

The central design bet is using Playwright's **ARIA snapshot** as the primary page
representation instead of raw DOM or screenshots.

### ARIA Tree = Semantic View

The ARIA (Accessible Rich Internet Applications) tree is the browser's
**accessibility layer** — the same structure screen readers consume. It represents
what a page *means*, not how it is *rendered*:

- A `<div class="btn-primary" onclick="submit()">` becomes `button "Submit"`
- A `<nav><ul><li><a>...` hierarchy becomes `navigation > list > link "Home"`
- Invisible elements, decorative wrappers, and layout containers are stripped away

This semantic compression is exactly what an LLM needs — understanding without noise.

### Token Efficiency

| Representation | Typical size for a medium page | Ratio |
|----------------|-------------------------------|-------|
| Raw DOM HTML | 50,000–200,000 tokens | 1× |
| ARIA snapshot | 1,000–5,000 tokens | 10–50× smaller |
| Screenshot (base64) | ~10,000 tokens (vision) | Requires multimodal |

A 50× reduction means the Agent can understand a page within its context window
without special chunking or summarization.

### `ref` Numbering

Playwright's ARIA snapshot can annotate each interactive element with a `ref`
attribute — a short identifier like `e1`, `e2`, `e3`. The LLM sees:

```
button "Login" [ref=e5]
textbox "Email" [ref=e6]
```

To click the login button, the LLM simply says `ref: "e5"`. Compare this to a CSS
selector (`button.btn-primary.login-form__submit`) which is verbose, fragile, and
hard for LLMs to produce reliably.

### Prior Art

- **OpenClaw** — Demonstrated ARIA-based browser automation with LLMs at scale
- **Playwright MCP** — Official Playwright team's MCP server uses the same ARIA
  snapshot + ref approach, validating it as a production-ready pattern

---

## 4. Screenshot Strategy

### Why V1 Does Not Use Multimodal Vision

Screenshots are valuable for human debugging, but V1 deliberately avoids sending
them to the LLM as image content:

1. **Message type constraint** — `Message.content` is currently a plain `string`.
   Supporting images requires adding `ImageContent` (or a union content type),
   which ripples through `llm-types`, `pi-ai-adapter`, `token-counter`, and
   every provider adapter.

2. **ARIA is sufficient** — For the tasks Browser Tools target (form filling,
   navigation, data extraction), the ARIA snapshot provides enough information
   for the LLM to act correctly. Visual layout understanding is rarely needed.

3. **Token cost** — Even with vision models, a single screenshot consumes
   ~10,000 tokens. A multi-step workflow with 10 page loads would burn 100K
   tokens on images alone. ARIA keeps costs predictable.

### What V1 Does Instead

- Screenshots are captured and **saved to disk** for human inspection and debugging
- The file path is returned in the tool result so operators can review what the
  Agent saw
- When `Message` gains `ImageContent` support in the future, screenshots can be
  routed to the LLM with minimal tool-side changes

---

## 5. Security Considerations

Browser Tools introduce a new attack surface — the Agent can now reach arbitrary
web content. V1 applies baseline protections:

| Measure | What It Prevents |
|---------|-----------------|
| **URL scheme allowlist** (`http`, `https` only) | `file://`, `javascript:`, `data:` scheme abuse |
| **Lazy launch** | No browser process running until explicitly needed |
| **Agent-level singleton** | Single controlled browser instance, no orphaned processes |

### Planned Enhancements (Post-V1)

| Enhancement | What It Addresses |
|-------------|------------------|
| **Docker sandbox** | Full process isolation — browser runs in a container with no host network access |
| **Private network detection** | Block requests to `127.0.0.1`, `10.x.x.x`, `169.254.x.x`, and other internal ranges (SSRF) |
| **CDP authentication** | Secure the Chrome DevTools Protocol endpoint to prevent local exploitation |
| **Domain allowlist/blocklist** | Operator-configurable restrictions on which sites the Agent may visit |

---

## 6. Future Directions

- **Docker sandbox mode** — Run the browser in an isolated container for
  production deployments
- **Multimodal screenshots** — Send page captures to the LLM as `ImageContent`
  once `Message` supports it, enabling visual reasoning for complex layouts
- **Tab management** — Multiple tabs for parallel information gathering
- **Cookie/auth persistence** — Save and restore browser sessions across Agent
  restarts
- **Comprehensive SSRF protection** — IP range checks, DNS rebinding prevention,
  redirect validation
- **Iframe and shadow DOM support** — Extend ARIA snapshot to cross isolation
  boundaries when needed
