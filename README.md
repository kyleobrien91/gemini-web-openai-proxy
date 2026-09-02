# Gemini Web OpenAI-Compatible Proxy

An OpenAI-compatible reverse proxy (/v1/chat/completions, /v1/models) that connects directly to a live, authenticated Google Gemini Web session using the Chrome DevTools Protocol (CDP).

## Features
- **OpenAI Specification Compatibility:** Drop-in replacement for OpenAI SDKs, OpenCode, Cline, Claude Code, etc.
- **Full Tool / Function Calling:** Uses system prompt schema injection + streaming XML parser (<tool_call>).
- **CDP Session Bridge:** Reuses active browser authentication over port 9222 without exposing plaintext credentials.
- **Streaming (SSE):** Delivers real-time generation chunks matching OpenAI delta specs.

For full technical specifications, see [PRD.md](./PRD.md).
