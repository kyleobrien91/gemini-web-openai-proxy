# Implementer Handoff: MVP Runtime Hardening for Gemini Web OpenAI Proxy

## Summary
Implements MVP runtime hardening for the Gemini Web OpenAI Proxy to satisfy **GitHub Issues #5 and #6** on feature branch `feature/mvp-opencode-cdp-hardening`.

Cross-references:
- Closes https://github.com/kyleobrien91/gemini-web-openai-proxy/issues/5
- Closes https://github.com/kyleobrien91/gemini-web-openai-proxy/issues/6
- Vikunja Project #5 (Tasks #15, #16)

---

## 1. Key Changes & Architecture

### R1. Resilient Stream Reconciliation (`src/cdp/stream-listener.ts`) — GitHub Issue #5
1. **Multi-tier Stream Reconciliation Engine**:
   - Replaced fragile `.startsWith(lastText)` check with:
     1. Fast path: exact prefix match (`current.startsWith(last)`).
     2. Lookback Suffix Anchor: sliding window from 50 down to 10 chars (`lastIndexOf`) to anchor continuations across minor prefix mutations.
     3. Structural Non-Whitespace Alignment: matches non-whitespace sequence to handle layout reflow and whitespace collapsing.
     4. Transient mutation debouncing and settling (800ms settlement before evaluating discontinuity).
2. **CRLF Line-Ending Normalization**:
   - Normalized `\r\n` to `\n` across DOM text extractions.
3. **Structured Code-Block Text Extraction**:
   - Explicitly parses `<code-block>` / `code[data-test-id="code-content"]` and decoration language tag into markdown fences, preventing "Pythondef" token concatenation and whitespace collapse.
4. **Stream Completion Detection**:
   - Tracks text stability (`currentText === lastStableText`) over 5 consecutive intervals (2.5 seconds) ensuring no active Stop button exists and editor has returned to idle/dictate state before signaling stream completion.
   - Reliably selects active `message-content` Web Component (`elements[elements.length - 1]`).

### R2. Large Context Input & Submit Hardening (`src/cdp/browser.ts`, `src/config.ts`) — GitHub Issue #6
1. **4-Level Prompt Insertion Hierarchy**:
   - Model-aware bulk insertion via Quill API (`quill.setText(inputPrompt, 'user')`).
   - Synthetic clipboard paste (`DataTransfer` / `ClipboardEvent('paste')`).
   - `document.execCommand('insertText', false, inputPrompt)`.
   - Last-resort DOM mutation with `<p>` tag splitting and empty-line `<br>` preservation.
2. **Active DOM Event Dispatch**:
   - Dispatches `input` and `change` events (`bubbles: true, composed: true`) to trigger Angular change detection.
3. **Configurable Usability Polling Loop**:
   - Added `submitTimeoutMs` (default: 20000ms) in `src/config.ts`.
   - Increased default `requestTimeoutMs` from 60000ms to 180000ms (3 minutes) to accommodate long-running code streams.
   - Hardened submit button usability polling loop to check for visible bounds, `disabled`, `aria-disabled`, and parent `gem-icon-button` status.
4. **Escape Safety**:
   - Serializes prompt via `JSON.stringify` while escaping `\u2028` and `\u2029`, preserving single/double quotes, backslashes, XML tags, and newlines byte-for-byte.

### R3. CDP Compatibility & Tab Management
1. **CDP Return Structure Compatibility**:
   - Updated `Runtime.evaluate` checks in `browser.ts`, `stream-listener.ts`, `mode-switcher.ts`, and `tab-manager.ts` to `res?.result?.value ?? res?.value`, supporting both raw CDP and test mocks.
2. **Target Discovery Hardening**:
   - Filters targets to page type and `gemini.google.com` URL.

---

## 2. Verification Record

### Static Typing & Build Check
- `npm run build` executed with exit code 0 and zero TypeScript errors.

### Issue #5: Large Code Output Streaming (Live Verification)
- **Python Code Streaming (100+ lines)**:
  - Request: `gemini-3.7-flash`, prompt demanding complete Graph module with Dijkstra, BFS, DFS, Topological Sort.
  - HTTP Status: `200 OK`
  - Stream ended with `[DONE]`: `true`
  - DOM Discontinuity Errors: `false` (0 errors)
  - Duration: `23.8s`
  - Total Characters: `10,211`
  - Total Output Lines: `283`
  - Code Block Lines: `281` (clean syntax, proper indentation)
- **TypeScript Code Streaming (100+ lines)**:
  - Request: `gemini-3.7-flash`, prompt demanding EventBus & Observable pattern with generics and tests.
  - HTTP Status: `200 OK`
  - Stream ended with `[DONE]`: `true`
  - DOM Discontinuity Errors: `false` (0 errors)
  - Duration: `20.0s`
  - Total Characters: `8,955`
  - Total Output Lines: `298`
  - Code Block Lines: `293` (clean syntax, valid types)

### Issue #6: Benchmarking & Escape Safety (Live Verification)
- **Escape Safety Payload**:
  - Size: 483 characters (nested JSON, `<tool_call>` XML tags, shell command regexes, escaped quotes, Windows backslashes `C:\Windows\System32\drivers\etc\hosts`).
  - Byte-for-byte Match: `true` (483 / 483 characters exact match).
  - Submit Button Usable Within: `455.3 ms` (Attempts: 1).
- **10k Token Benchmark**:
  - Payload Size: `37,288` characters, `10,078` calculated tokens.
  - Submit Button Usable Within: `1,735.4 ms` (< 3,000 ms threshold) — **PASSED**.
- **20k Token Benchmark**:
  - Payload Size: `74,244` characters, `20,066` calculated tokens.
  - Submit Button Usable Within: `785.5 ms` (< 6,000 ms threshold) — **PASSED**.
- **30k Token Benchmark**:
  - Payload Size: `111,239` characters, `30,065` calculated tokens.
  - Submit Button Usable Within: `769.2 ms` (< 12,000 ms threshold) — **PASSED**.
