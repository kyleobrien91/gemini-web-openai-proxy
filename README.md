# Gemini Web OpenAI-Compatible Proxy

An OpenAI-compatible reverse proxy intended for OpenAI-compatible clients/agents such as OpenCode and Cline. It connects directly to a live, authenticated Google Gemini Web session using the Chrome DevTools Protocol (CDP).

## Phase 2 MVP - OpenCode Integration

This proxy is designed to serve as the backend for the OpenCode agent loop. It allows OpenCode to autonomously perform real coding/computer operations by injecting its native tools into a Gemini session and interpreting the responses.

**Important Note:** The proxy itself does not execute shell/filesystem/browser tools. It simply converts OpenCode's tools into a Gemini-readable format, parses Gemini's proprietary output, and returns standard OpenAI `tool_calls` for OpenCode to execute locally.

## Features
- **OpenAI Specification Compatibility:** Acts as a backend endpoint for agents requiring standard `v1/chat/completions` inputs.
- **Full Tool / Function Calling:** Uses system prompt schema injection + strict JSON schema validation for parsing XML (`<tool_call>`).
- **CDP Session Bridge:** Reuses active browser authentication over port 9222 without exposing plaintext credentials.
- **Streaming & Reflection:** Delivers real-time generation chunks. In non-streaming mode (`stream: false`), malformed or invalid tool output may trigger automatic Tier-2 reflection/retries within the same conversation to recover. In streaming mode (`stream: true`), reflection is intentionally disabled (because already-emitted chunks cannot be retracted) and an invalid tool call immediately terminates the stream without emitting a successful completion marker.

## Known Limitations
- **DOM Streaming Heuristics:** Stream token extraction relies on observing DOM UI components via `MutationObserver`. A direct integration using the CDP Network/Fetch domains to capture raw backend network chunk streams is scheduled for a future version.
- **Single Worker Serialization:** To prevent session corruption, the proxy runs a single queue. All incoming completion requests are strictly serialized and wait for the active request to complete.

## Setup

1. **Install & Build:**
   ```bash
   npm install
   npm run build
   ```

2. **Start the Proxy:**
   ```bash
   npm start
   ```
   *(Or `npm run dev` for development with live reload)*

3. **Log in once:**
   - The proxy will automatically locate Chrome/Brave/Edge and launch an isolated browser window with a dedicated user profile directory (`~/.gemini-web-openai-proxy/chrome-profile`).
   - If you are not signed in, the terminal will prompt you to complete Google Gemini login in the opened browser window.
   - Once logged in, session cookies are preserved. On subsequent runs, you will not need to log in again!

*(Optional Manual Mode)*: If you prefer to launch your own browser instance manually, simply launch Chrome with `--remote-debugging-port=9222` (or your custom port) before starting the proxy. The proxy detects existing CDP instances and attaches automatically without launching a new one.

## Environment Flags

You can customize the proxy using environment variables or a `.env` file:
- `PORT`: The port the proxy listens on (default: `8000`).
- `CDP_HOST`: The host for CDP connection (default: `127.0.0.1`).
- `CDP_PORT`: The port for CDP connection (default: `9222`).
- `AUTO_LAUNCH_BROWSER`: Set to `false` to disable auto-launching Chrome (default: `true`).
- `CHROME_PATH`: Custom path to browser executable (auto-detected by default).
- `CHROME_USER_DATA_DIR`: Custom path for dedicated browser profile (default: `~/.gemini-web-openai-proxy/chrome-profile`).
- `KEEP_BROWSER_OPEN_ON_EXIT`: Set to `true` to prevent the proxy from closing the browser window when exiting (default: `false`).
- `REQUEST_TIMEOUT_MS`: Timeout for prompt generation (default: `60000`).
- `MAX_RETRIES`: Number of retries for automated reflection (default: `2`).

## OpenCode Configuration

To use this proxy in OpenCode, specify an `openai-compatible` custom provider in your `~/.opencode/config.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "gemini-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Gemini Web",
      "options": {
        "baseURL": "http://127.0.0.1:8000/v1"
      },
      "models": {
        "gemini-flash": {
          "name": "Gemini Flash (Standard)"
        },
        "gemini-flash-extended": {
          "name": "Gemini Flash (Extended Thinking)"
        },
        "gemini-pro": {
          "name": "Gemini Pro (Standard)"
        },
        "gemini-pro-extended": {
          "name": "Gemini Pro (Extended Thinking)"
        },
        "gemini-flash-lite": {
          "name": "Gemini Flash Lite"
        },
        "default": {
          "name": "Default (Current Browser Selection)"
        }
      }
    }
  },
  "model": "gemini-proxy/gemini-flash"
}
```

The proxy maps directly to the modes on the Gemini Web interface:
- **`gemini-flash`** (or `flash`): Selects **Flash** and ensures Extended Thinking is **disabled**.
- **`gemini-flash-extended`** (or `flash-extended`, `gemini-thinking`): Selects **Flash** and ensures Extended Thinking is **enabled**.
- **`gemini-pro`** (or `pro`): Selects **Pro** and ensures Extended Thinking is **disabled**.
- **`gemini-pro-extended`** (or `pro-extended`): Selects **Pro** and ensures Extended Thinking is **enabled**.
- **`gemini-flash-lite`** (or `flash-lite`): Selects **Flash Lite**.
- **`default`**: Uses whatever model and thinking state is currently selected in the browser.

*(Versioned IDs such as `gemini-3.8-flash`, `gemini-3.8-flash-extended`, `gemini-3.1-pro-extended` are also preserved as aliases).*


