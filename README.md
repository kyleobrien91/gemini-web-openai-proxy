# Gemini Web OpenAI-Compatible Proxy

An OpenAI-compatible reverse proxy intended for OpenAI-compatible clients/agents such as OpenCode and Cline. It connects directly to a live, authenticated Google Gemini Web session using the Chrome DevTools Protocol (CDP).

## Features
- **OpenAI Specification Compatibility:** Acts as a backend endpoint for IDE plugins and agents requiring standard `v1/chat/completions` inputs.
- **Full Tool / Function Calling:** Uses system prompt schema injection + strict JSON schema validation for parsing XML (`<tool_call>`).
- **CDP Session Bridge:** Reuses active browser authentication over port 9222 without exposing plaintext credentials.
- **Streaming (SSE):** Delivers real-time generation chunks matching OpenAI delta specs.
