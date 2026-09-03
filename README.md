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

1. **Start Chrome/Brave with CDP enabled:**
   Launch your browser with the `--remote-debugging-port=9222` flag. Ensure you are logged into Gemini (`https://gemini.google.com/app`) in one of the tabs.

   Example for Mac:
   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
   ```

2. **Install & Build:**
   ```bash
   npm install
   npm run build
   ```

3. **Start the Proxy:**
   ```bash
   npm run start &
   ```
   The proxy will default to listening on `http://localhost:8000`.

## Environment Flags

You can customize the proxy using environment variables or a `.env` file:
- `PORT`: The port the proxy listens on (default: `8000`).
- `CDP_HOST`: The host for CDP connection (default: `127.0.0.1`).
- `CDP_PORT`: The port for CDP connection (default: `9222`).
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
        "gemini-3.7-flash": {
          "name": "Gemini 3.7 Flash"
        },
        "gemini-3.1-pro": {
          "name": "Gemini 3.1 Pro"
        },
        "gemini-3.5-flash-lite": {
          "name": "Gemini 3.5 Flash Lite"
        },
        "gemini-2.5-pro": {
          "name": "Gemini 2.5 Pro"
        },
        "gemini-2.5-flash": {
          "name": "Gemini 2.5 Flash"
        }
      }
    }
  },
  "model": "gemini-proxy/gemini-3.7-flash"
}
```

The supported model IDs exactly match those specified in this configuration block. Using other arbitrary IDs will result in an error.
