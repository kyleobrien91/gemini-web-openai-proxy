# Original User Request

## Initial Request — 2026-09-04T03:29:54Z

This is a single self-contained fix; keep it small and focused. Implement MVP runtime hardening for the Gemini Web OpenAI Proxy to satisfy GitHub Issues #5 and #6 in a single feature branch and Pull Request, verified by clean compilation and live runtime browser benchmarks.

Working directory: w:/home/user/development/gemini-web-openai-proxy
Integrity mode: development

## Core Operational Directives

- **Automated Unit Test Freeze:** Testing is suspended until after Phase 4. DO NOT create new test files in `tests/`, DO NOT modify files in `tests/`, DO NOT run `npm test` or `vitest`.
- **Authoritative Acceptance Criteria:** The stated acceptance criteria are authoritative. Treat insertion mechanisms (Quill API, clipboard, execCommand) and DOM reconciliation strategies as implementation candidates; adjust strategy if runtime behavior disproves an assumption.
- **Verification Method:** Programmatic build check (`npm run build`) and live browser execution on port 9222.

## Requirements

### R1. Resilient Stream Reconciliation (`src/cdp/stream-listener.ts`) — GitHub Issue #5
- Replace strict `currentText.startsWith(lastText)` with a resilient matching mechanism (lookback suffix anchor, structural non-whitespace alignment, and transient mutation debouncing/settling) to prevent false-positive `DOM rewrite detected; stream discontinuity` aborts during code block emission, `<pre><code>` reflow, syntax highlighting, and whitespace normalization.
- Normalize CRLF line-endings (`\r\n` -> `\n`) across DOM extractions.

### R2. Large Context Input & Submit Hardening (`src/cdp/browser.ts`, `src/config.ts`) — GitHub Issue #6
- Implement safe prompt insertion into `.ql-editor` supporting up to 30k tokens. Fallback hierarchy: model-aware bulk insertion via Quill API → synthetic clipboard paste → `execCommand('insertText')` → last-resort DOM mutation with editor state verification.
- Actively trigger DOM input/change events to wake Angular change detection.
- Add configurable `submitTimeoutMs` (default: 20000ms) in `src/config.ts` and harden submit button usability polling loop to accommodate heavy DOM layout computation without premature timeout.
- Ensure escape safety: preserve quotes (`"`, `'`), backslashes (`\`, `\\`), newlines, and XML delimiters (`<tool_call>`, `</tool_call>`) byte-for-byte.

### R3. Git Feature Branch & Pull Request Delivery
- Develop on a dedicated feature branch: `feature/mvp-opencode-cdp-hardening`.
- Commit changes with conventional commits.
- Push to origin and open a Pull Request linking:
  - `Closes https://github.com/kyleobrien91/gemini-web-openai-proxy/issues/5`
  - `Closes https://github.com/kyleobrien91/gemini-web-openai-proxy/issues/6`
  - Cross-reference Vikunja Project #5 Tasks #15 and #16.

## Acceptance Criteria

### Compilation & Static Typing
- [ ] `npm run build` passes with zero TypeScript errors.

### Issue #5: Large Code Output Streaming
- [ ] Prompt demanding 100+ lines of Python code streams to completion ending with `[DONE]` without triggering `DOM rewrite detected; stream discontinuity`.
- [ ] Prompt demanding 100+ lines of TypeScript code streams to completion ending with `[DONE]` without triggering `DOM rewrite detected; stream discontinuity`.
- [ ] Generated code preserves valid syntax and block formatting.

### Issue #6: Benchmarking & Escape Safety (Report Exact Calculated Token Counts)
- [ ] **Escape Safety Payload:** Complex payload containing unescaped single/double quotes, backslashes, XML tags (`<tool_call>`), and nested JSON survives insertion byte-for-byte; submit button activates cleanly.
- [ ] **10k Token Benchmark:** Realistic multi-file code context (~10k calculated tokens) is inserted without tab freeze and submit button becomes usable within < 3 seconds.
- [ ] **20k Token Benchmark:** Realistic multi-file code context (~20k calculated tokens) is inserted and submit button becomes usable within < 6 seconds.
- [ ] **30k Token Benchmark:** Realistic multi-file code context (~30k calculated tokens) is inserted without script evaluation lag and submit button becomes usable within < 12 seconds (no timeout).
