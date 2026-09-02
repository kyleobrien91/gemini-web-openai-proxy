# Gemini Web OpenAI-Compatible Proxy

An OpenAI-compatible reverse proxy (`/v1/chat/completions`, `/v1/models`) that connects directly to a live, authenticated Google Gemini Web session using the Chrome DevTools Protocol (CDP).

## Features
- **OpenAI Specification Compatibility:** Drop-in replacement for OpenAI SDKs, OpenCode, Cline, Claude Code, etc.
- **Full Tool / Function Calling:** Uses system prompt schema injection + streaming XML parser (`<tool_call>`).
- **CDP Session Bridge:** Reuses active browser authentication over port 9222 without exposing plaintext credentials.
- **Streaming (SSE):** Delivers real-time generation chunks matching OpenAI delta specs.

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
   npm run start
   ```
   The proxy will default to listening on `http://localhost:8000`.

## Environment Flags

You can customize the proxy using environment variables or a `.env` file:
- `PORT`: The port the proxy listens on (default: `8000`).
- `CDP_HOST`: The host for CDP connection (default: `127.0.0.1`).
- `CDP_PORT`: The port for CDP connection (default: `9222`).
- `REQUEST_TIMEOUT_MS`: Timeout for prompt generation (default: `60000`).
- `MAX_RETRIES`: Number of retries for automated reflection (default: `2`).

## OpenCode Configuration Snippet

To use this proxy in OpenCode, update your `~/.opencode/config.json`:

```json
{
  "apiHost": "http://127.0.0.1:8000/v1",
  "defaultModel": "gemini-3.7-flash"
}
```

For full technical specifications, see [PRD.md](./PRD.md).
