# Product Requirement Document (PRD)
## OpenAI-Compatible Reverse Proxy for Gemini Web (with Tool Calling & OpenCode Integration)

---

## 1. Executive Summary & Objective

### 1.1 Problem Statement
Developer tools, coding agents (such as **OpenCode**, Cline, Claude Code), and AI client applications adhere strictly to the OpenAI REST API specification (`/v1/chat/completions`) with Server-Sent Events (SSE) streaming and native tool/function calling schemas. However, proprietary web interfaces like **Google Gemini Web** provide generous web context tiers and web browsing capabilities through an internal, stateful RPC protocol (`StreamGenerate` / `batchexecute`) that is inaccessible to standard OpenAI client SDKs.

### 1.2 Objective
Develop a local, high-performance, TypeScript-based reverse proxy that presents a standard OpenAI-compatible API interface (`/v1/models`, `/v1/chat/completions`) powered by a live, authenticated Chrome/Brave browser session via the **Chrome DevTools Protocol (CDP)**. The proxy will seamlessly support:
1. **Streaming responses (SSE)** matching OpenAI delta chunks.
2. **First-class Tool/Function Calling** via schema injection and XML delimiter parsing (`<tool_call>`).
3. **Stateless context management** with multi-turn message flattening suitable for agentic coding tools like OpenCode.
4. **Model selection routing** (e.g. Pro vs Flash) mapped to web UI selectors.

---

## 2. Target Persona & Use Cases

- **Target Persona:** Developers running local coding agents (OpenCode, Roo Code, Aider, Cline) who want to leverage their active Gemini Advanced web subscriptions directly within IDE workflows.
- **Primary Use Cases:**
  - **OpenCode Model Backend:** Executing coding tasks where OpenCode issues bash commands, file edits, and codebase searches via OpenAI-style `tool_calls`.
  - **IDE Chat & Code Generation:** General OpenAI API drop-in replacement (`http://localhost:8000/v1`) for tools expecting standard completion streaming.
  - **Live Browser Session Reuse:** No manual API keys or cookie scraping required; proxy automatically attaches to the user's running Brave/Chrome instance over port 9222.

---

## 3. Architecture & System Flow

```
┌────────────────────────────────────────────────────────┐
│             OpenCode / OpenAI API Client               │
└──────────────────────────┬─────────────────────────────┘
                           │ POST /v1/chat/completions (SSE)
                           ▼
┌────────────────────────────────────────────────────────┐
│           Gemini Web OpenAI Proxy (Node/TS)            │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ 1. Request Normalizer & Tool Schema Injector     │  │
│  │    - Formats system instructions                 │  │
│  │    - Injects XML tool schemas into prompt        │  │
│  │    - Flattens multi-turn user/assistant history  │  │
│  └──────────────────────────┬───────────────────────┘  │
│                             │                          │
│  ┌──────────────────────────▼───────────────────────┐  │
│  │ 2. CDP Driver / Browser Worker Pool             │  │
│  │    - Connects to ws://127.0.0.1:9222/devtools/.. │  │
│  │    - Opens/recycles clean tab or dispatches RPC  │  │
│  │    - Hooks Network/Fetch & DOM streams           │  │
│  └──────────────────────────┬───────────────────────┘  │
│                             │                          │
│  ┌──────────────────────────▼───────────────────────┐  │
│  │ 3. Streaming Lexer & Tool Call State Machine     │  │
│  │    - Buffers tokens on `<tool_call>` tag         │  │
│  │    - Translates XML to OpenAI `tool_calls` delta │  │
│  │    - Emits SSE chunks: `data: {"choices": [...]}`│  │
│  └──────────────────────────────────────────────────┘  │
└──────────────────────────┬─────────────────────────────┘
                           │ CDP WebSocket (ws://127.0.0.1:9222)
                           ▼
┌────────────────────────────────────────────────────────┐
│           Brave / Chrome (Port 9222 Session)           │
│           https://gemini.google.com/app                │
└────────────────────────────────────────────────────────┘
```

---

## 4. Detailed Functional Requirements

### 4.1 Endpoints Specification

#### 4.1.1 `GET /v1/models`
Returns list of available models to satisfy client initialization, UI selectors, and validation in OpenAI-compatible frontends (OpenCode, Cline, LibreChat).

These models map directly to the **real options available in the web interface UI selectors** (e.g. Gemini Web's `bard-mode-menu-button` and Claude Web options):

- **Request:** `GET /v1/models`
- **Response (200 OK):**
```json
{
  "object": "list",
  "data": [
    {
      "id": "gemini-3.7-flash",
      "object": "model",
      "created": 1740000000,
      "owned_by": "google-web",
      "permission": [],
      "root": "gemini-3.7-flash",
      "parent": null,
      "metadata": {
        "web_label": "3.7 Flash (All-around help)",
        "web_dom_testid": "bard-mode-option-56fdd199312815e2"
      }
    },
    {
      "id": "gemini-3.7-flash-thinking",
      "object": "model",
      "created": 1740000000,
      "owned_by": "google-web",
      "permission": [],
      "root": "gemini-3.7-flash-thinking",
      "parent": null,
      "metadata": {
        "web_label": "3.7 Flash + Extended thinking (Complex problem solving)",
        "thinking": true
      }
    },
    {
      "id": "gemini-3.5-flash-lite",
      "object": "model",
      "created": 1740000000,
      "owned_by": "google-web",
      "permission": [],
      "root": "gemini-3.5-flash-lite",
      "parent": null,
      "metadata": {
        "web_label": "3.5 Flash-Lite (Fastest answers)",
        "web_dom_testid": "bard-mode-option-8c46e95b1a07cecc"
      }
    },
    {
      "id": "gemini-3.1-pro",
      "object": "model",
      "created": 1740000000,
      "owned_by": "google-web",
      "permission": [],
      "root": "gemini-3.1-pro",
      "parent": null,
      "metadata": {
        "web_label": "3.1 Pro (Advanced reasoning)",
        "web_dom_testid": "bard-mode-option-e6fa609c3fa255c0"
      }
    },
    {
      "id": "gemini-2.5-pro",
      "object": "model",
      "created": 1740000000,
      "owned_by": "google-web",
      "permission": [],
      "root": "gemini-2.5-pro",
      "parent": null,
      "metadata": {
        "alias_for": "gemini-3.1-pro"
      }
    },
    {
      "id": "gemini-2.5-flash",
      "object": "model",
      "created": 1740000000,
      "owned_by": "google-web",
      "permission": [],
      "root": "gemini-2.5-flash",
      "parent": null,
      "metadata": {
        "alias_for": "gemini-3.7-flash"
      }
    },
    {
      "id": "claude-3-7-sonnet",
      "object": "model",
      "created": 1740000000,
      "owned_by": "anthropic-web",
      "permission": [],
      "root": "claude-3-7-sonnet",
      "parent": null,
      "metadata": {
        "web_label": "Claude 3.7 Sonnet (claude.ai)"
      }
    },
    {
      "id": "claude-3-7-sonnet-thinking",
      "object": "model",
      "created": 1740000000,
      "owned_by": "anthropic-web",
      "permission": [],
      "root": "claude-3-7-sonnet-thinking",
      "parent": null,
      "metadata": {
        "web_label": "Claude 3.7 Sonnet + Extended Thinking (claude.ai)",
        "thinking": true
      }
    },
    {
      "id": "claude-3-5-sonnet",
      "object": "model",
      "created": 1740000000,
      "owned_by": "anthropic-web",
      "permission": [],
      "root": "claude-3-5-sonnet",
      "parent": null
    },
    {
      "id": "claude-3-5-haiku",
      "object": "model",
      "created": 1740000000,
      "owned_by": "anthropic-web",
      "permission": [],
      "root": "claude-3-5-haiku",
      "parent": null
    }
  ]
}
```

#### 4.1.2 `POST /v1/chat/completions`
Core inference endpoint supporting non-streaming and streaming (SSE) modes.
- **Headers:** `Content-Type: application/json`, `Authorization: Bearer <optional>`
- **Payload Schema:**
  - `model` *(string, required)*: e.g. `gemini-2.5-pro`
  - `messages` *(array, required)*: List of `{ role, content, tool_calls, tool_call_id }`
  - `tools` *(array, optional)*: List of OpenAI tool definitions with JSON schema parameters
  - `tool_choice` *(string/object, optional)*: e.g. `"auto"`, `"none"`, or specific function
  - `stream` *(boolean, optional, default: false)*: Whether to stream SSE deltas
  - `temperature` / `top_p` *(float, optional)*

---

### 4.2 Prompt Normalization & History Flattening

Because the proxy operates in **Stateless New-Chat Mode** for deterministic agent behavior, incoming OpenAI message arrays must be serialized into a single coherent prompt for the web interface.

#### 4.2.1 Role Serialization Rules
1. **System Messages (`role: "system"`):**
   - Placed at the top as `### System Instructions:`.
2. **Tool Schema Injection:**
   - Appended immediately below system instructions.
3. **Multi-Turn History:**
   - Sequential user/assistant turns are formatted with clean markdown blockquotes:
     ```markdown
     ### Conversation History:
     [User]:
     Create a python script called `serve.py` that starts a simple HTTP server on port 8080.

     [Assistant]:
     I will create the `serve.py` file using the `write_to_file` tool.
     <tool_call>
     {"name": "write_to_file", "arguments": {"path": "serve.py", "content": "import http.server\n..."}}
     </tool_call>

     [Tool Result (write_to_file)]:
     Successfully wrote 142 bytes to serve.py.

     ### Current Instruction:
     [User]:
     Now run the server to verify it works.
     ```

---

### 4.3 Tool Calling Subsystem (Function Calling)

#### 4.3.1 System Prompt Grammar Injection
When `tools` array is present in the request payload, the proxy prepends the following structured directive:

```text
[AVAILABLE TOOLS]
The following tools are available for you to execute tasks:
[
  {
    "name": "execute_command",
    "description": "Run a shell command in the terminal workspace",
    "parameters": {
      "type": "object",
      "properties": {
        "command": { "type": "string", "description": "The command line to execute" }
      },
      "required": ["command"]
    }
  },
  ...
]

[TOOL CALL INSTRUCTIONS]
If you decide to invoke one or more tools, you MUST output the tool call strictly wrapped inside <tool_call> and </tool_call> tags with valid JSON matching the schema:

<tool_call>
{"name": "tool_name_here", "arguments": {"param_key": "param_value"}}
</tool_call>

Rules:
1. Do not wrap the <tool_call> tags inside markdown code blocks (e.g. do not use ```xml or ```json).
2. Output plain text explanations before or after the tool call if needed.
3. All arguments must strictly match the parameter JSON schema.
```

#### 4.3.2 Streaming Delimiter Lexer & State Machine

The proxy processes the live token stream from Gemini via a 3-state lexer:

```
                  ┌───────────────────────┐
                  │      STATE: TEXT      │
                  │ (Emit content deltas) │
                  └──────────┬────────────┘
                             │
                  Sees '<' or match prefix
                             │
                             ▼
                  ┌───────────────────────┐
                  │    STATE: BUFFERING   │
                  │ (Hold potential tag)  │
                  └──────────┬────────────┘
                             │
          ┌──────────────────┴──────────────────┐
          │ Match: '<tool_call>'                │ No Match / Mismatch
          ▼                                     ▼
┌───────────────────────────┐         ┌───────────────────────────┐
│     STATE: TOOL_CALL      │         │   Flush buffer as text    │
│  (Parse JSON, emit tool   │         │    Return to STATE: TEXT  │
│   call deltas & finish)   │         └───────────────────────────┘
└───────────────────────────┘
```

#### 4.3.3 OpenAI SSE Tool Call Delta Stream Generation
When `<tool_call>` is matched, the proxy emits standard OpenAI tool chunks:

1. **Header Delta:**
```json
data: {"id":"chatcmpl-gemini-web","object":"chat.completion.chunk","created":1740000000,"model":"gemini-2.5-pro","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_01j8","type":"function","function":{"name":"execute_command","arguments":""}}]},"finish_reason":null}]}
```

2. **Argument Chunks (streamed or buffered):**
```json
data: {"id":"chatcmpl-gemini-web","object":"chat.completion.chunk","created":1740000000,"model":"gemini-2.5-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\": \"npm test\"}"}}]},"finish_reason":null}]}
```

3. **Finish Reason Delta:**
```json
data: {"id":"chatcmpl-gemini-web","object":"chat.completion.chunk","created":1740000000,"model":"gemini-2.5-pro","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
data: [DONE]
```

---

### 4.4 CDP Driver & Browser Worker Management

#### 4.4.1 Connection & Session Strategy
- **Port:** `http://127.0.0.1:9222`
- **Driver Layer:** Native Node.js WebSocket client communicating directly with Chrome DevTools Protocol (`Network`, `Page`, `Runtime`, `Fetch`).
- **Tab Worker Pool:**
  - Maintains a dedicated, isolated tab (`https://gemini.google.com/app`) for incoming proxy requests.
  - Clears context between distinct completions by executing `window.location.href = 'https://gemini.google.com/app'` or clicking "New Chat" via DOM automation.
- **Model Mode Switching:**
  - If request specifies `model: "gemini-2.5-pro"`, verify/click the Gemini UI model dropdown selector to activate Pro mode before prompt submission.
  - If `model: "gemini-2.5-flash"`, switch to Flash mode.

---

## 5. Non-Functional Requirements

### 5.1 Performance & Latency
- **Proxy Overhead:** Less than 15ms latency added between raw browser token reception and SSE client emission.
- **Concurrency:** Support queue-based serialization for single browser instance; return `429 Too Many Requests` or buffer requests cleanly if the browser tab is actively streaming.

### 5.2 Security & Isolation
- **Localhost Only:** Proxy must bind exclusively to `127.0.0.1` by default to prevent unauthorized network exposure of authenticated sessions.
- **Credential Hygiene:** No credentials or API keys stored in plaintext config; leverages existing local browser cookies in memory.

### 5.3 Reliability & Resilience
- **Auto-Reconnect:** If the CDP WebSocket disconnects (e.g. browser tab closed or refreshed), the proxy will automatically re-scan `http://127.0.0.1:9222/json` and re-attach within 2 seconds.
- **Timeout Protection:** Configurable timeout (default: 60s) for prompt generation; aborts CDP request and sends standard OpenAI error JSON on stall.

---

## 6. OpenCode Compatibility Checklist

| Requirement | Implementation Details | Status |
| :--- | :--- | :--- |
| **`GET /v1/models`** | Returns `gemini-2.5-pro` & `gemini-2.5-flash` with standard model objects | Mandatory |
| **`stream: true` SSE** | Follows OpenAI `data: {"choices":[{"delta":{...}}]}` syntax ending with `data: [DONE]` | Mandatory |
| **`tool_calls` delta format** | Formats `index`, `id`, `type: "function"`, and `finish_reason: "tool_calls"` accurately | Mandatory |
| **`role: "tool"` handling** | Normalizes tool output turns into clean prompt context for iterative loop completion | Mandatory |
| **Clean Token Delivery** | Filters out internal Gemini HTML tags, citations, or prompt metadata from content output | Mandatory |

---

## 7. Recommended Implementation Project Structure

```
gemini-web-openai-proxy/
├── src/
│   ├── index.ts               # Server entrypoint (Express/Fastify on :8000)
│   ├── config.ts              # Configuration (CDP port, timeouts, host)
│   ├── routes/
│   │   ├── models.ts          # GET /v1/models
│   │   └── completions.ts     # POST /v1/chat/completions
│   ├── cdp/
│   │   ├── client.ts          # CDP WebSocket manager & target discoverer
│   │   ├── browser.ts         # Page automation & prompt submission
│   │   └── stream.ts          # SSE & chunk listener
│   ├── tools/
│   │   ├── injector.ts        # Injects tool schemas into system prompt
│   │   └── lexer.ts           # Streaming XML delimiter parser state machine
│   └── utils/
│       ├── formatter.ts       # Multi-turn history serializer
│       └── sse.ts             # OpenAI SSE chunk generator
├── package.json
├── tsconfig.json
└── README.md
```

---

## 8. Success Metrics & Validation Plan

1. **OpenCode Basic Coding Test:** Run OpenCode with `defaultModel: "gemini-web-proxy/gemini-2.5-pro"` and ask it to write a 10-line CLI script. Must complete without format errors.
2. **Multi-Turn Tool Execution Test:** Ask OpenCode to `read_file`, inspect dependencies, and `write_to_file` in a single session. Must successfully perform all turns without dropping tool IDs.
3. **Streaming Responsiveness:** First token latency (TTFT) from browser to OpenCode UI under 1.5 seconds.
