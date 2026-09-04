import { CDPConnection } from './connection.js';
import { TabManager } from './tab-manager.js';
import { ModeSwitcher } from './mode-switcher.js';
import { StreamListener, StreamListenerHandle } from './stream-listener.js';
import { config } from '../config.js';

export class BrowserWorker {
    public cdp: CDPConnection;
    public tabManager: TabManager;
    public modeSwitcher: ModeSwitcher;
    public streamListener: StreamListener;

    constructor() {
        this.cdp = new CDPConnection();
        this.tabManager = new TabManager(this.cdp);
        this.modeSwitcher = new ModeSwitcher(this.cdp);
        this.streamListener = new StreamListener(this.cdp);
    }

    private async initialize(isRetry: boolean = false) {
        const target = await this.cdp.discoverTarget();
        await this.cdp.connect(target.webSocketDebuggerUrl);
        // Only reset the chat tab if this is a fresh request
        if (!isRetry) {
             await this.tabManager.ensureGeminiTab();
        }
    }

    async submitPrompt(turnId: string, prompt: string, model: string, onToken: (token: string) => void, signal?: AbortSignal, isRetry: boolean = false): Promise<StreamListenerHandle | null> {
        if (signal?.aborted) return null;

        // Initialization happens inside the route lock. We pass isRetry to prevent chat reset.
        await this.initialize(isRetry);
        if (signal?.aborted) return null;

        // 1. Switch mode
        await this.modeSwitcher.switchMode(model);
        if (signal?.aborted) return null;

        // 2. Setup listener BEFORE submitting, guaranteeing completion of setup
        const streamHandle = await this.streamListener.setup(turnId, onToken, signal);
        if (signal?.aborted) {
            await streamHandle.cleanup();
            return null;
        }

        // 3. Submit prompt via hardened DOM automation supporting up to 30k tokens
        const timeoutMs = config.submitTimeoutMs;
        // Escape-safe serialization preserving quotes, backslashes, XML tags, and newlines byte-for-byte
        const serializedPrompt = JSON.stringify(prompt)
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');

        const script = `
            (async function(inputPrompt, timeoutLimitMs) {
                const state = window['__proxyTurn_${turnId}'];
                if (!state || state.aborted) return "ABORTED";

                const editor = document.querySelector('.ql-editor.textarea[contenteditable="true"], .ql-editor[contenteditable="true"], .ql-editor');
                if (!editor) return "EDITOR_NOT_FOUND";

                let inserted = false;

                // Hierarchy Level 1: Model-aware bulk insertion via Quill API
                const quill = editor.parentElement?.__quill || editor.__quill || (window.Quill && window.Quill.find ? window.Quill.find(editor) : null);
                if (quill && typeof quill.setText === 'function') {
                    try {
                        quill.setText(inputPrompt, 'user');
                        inserted = true;
                    } catch (e) {
                        console.warn('Quill bulk insertion failed, attempting fallback:', e);
                    }
                }

                // Hierarchy Level 2: Synthetic clipboard paste
                if (!inserted) {
                    try {
                        editor.focus();
                        document.execCommand('selectAll', false, null);
                        const dt = new DataTransfer();
                        dt.setData('text/plain', inputPrompt);
                        const pasteEvt = new ClipboardEvent('paste', {
                            clipboardData: dt,
                            bubbles: true,
                            cancelable: true,
                            composed: true
                        });
                        editor.dispatchEvent(pasteEvt);
                        if (editor.textContent && editor.textContent.length > 0) {
                            inserted = true;
                        }
                    } catch (e) {
                        console.warn('Synthetic clipboard paste failed, attempting fallback:', e);
                    }
                }

                // Hierarchy Level 3: execCommand('insertText')
                if (!inserted) {
                    try {
                        editor.focus();
                        document.execCommand('selectAll', false, null);
                        inserted = document.execCommand('insertText', false, inputPrompt);
                    } catch (e) {
                        console.warn('execCommand insertText failed, attempting fallback:', e);
                    }
                }

                // Hierarchy Level 4: Last-resort DOM mutation with editor state verification
                if (!inserted || (editor.textContent?.trim().length === 0)) {
                    try {
                        editor.innerHTML = '';
                        const lines = inputPrompt.replace(/\\r\\n|\\r/g, '\\n').split('\\n');
                        for (const line of lines) {
                            const p = document.createElement('p');
                            if (line.length === 0) {
                                p.appendChild(document.createElement('br'));
                            } else {
                                p.textContent = line;
                            }
                            editor.appendChild(p);
                        }
                        inserted = true;
                    } catch (e) {
                        console.warn('DOM mutation fallback failed:', e);
                    }
                }

                // Actively trigger DOM input/change events to wake Angular change detection
                try {
                    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertText', data: inputPrompt }));
                } catch (e) {
                    // Ignore if InputEvent not supported
                }
                editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                editor.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

                // Editor state verification: verify editor contains non-empty content
                const currentContent = (quill && typeof quill.getText === 'function')
                    ? quill.getText().replace(/\\n$/, '')
                    : (editor.innerText || editor.textContent || '').trim();

                if (!currentContent && inputPrompt.length > 0) {
                    return "EDITOR_INSERTION_VERIFICATION_FAILED";
                }

                // Wait for the send button to become genuinely usable
                return new Promise((resolve) => {
                    let attempts = 0;
                    const intervalMs = 100;
                    const maxAttempts = Math.ceil(timeoutLimitMs / intervalMs);

                    state.submitInterval = setInterval(() => {
                        if (state.aborted) {
                            clearInterval(state.submitInterval);
                            resolve("ABORTED");
                            return;
                        }

                        attempts++;
                        const submitBtn = document.querySelector('button[aria-label="Send message" i], button[aria-label="Send prompt" i], button.send-button-container, .send-button button, [data-test-id="send-button"]');

                        // Strict usability check: exists, visible, not disabled, no aria-disabled
                        const isVisible = submitBtn && (submitBtn.offsetParent !== null || submitBtn.getBoundingClientRect().height > 0);
                        const isEnabled = submitBtn && !submitBtn.disabled && submitBtn.getAttribute('aria-disabled') !== 'true' && !submitBtn.closest('[aria-disabled="true"]');

                        if (isVisible && isEnabled) {
                            clearInterval(state.submitInterval);
                            // Final safety check immediately before click
                            if (state.aborted || !window.location.href.includes('gemini.google.com')) {
                                resolve("ABORTED");
                                return;
                            }
                            submitBtn.click();
                            resolve("SUCCESS");
                        } else if (attempts >= maxAttempts) {
                            clearInterval(state.submitInterval);
                            resolve("SUBMIT_BTN_NOT_USABLE_OR_TIMEOUT");
                        }
                    }, intervalMs);
                });
            })(${serializedPrompt}, ${timeoutMs})
        `;

        let submitRes;
        try {
            submitRes = await this.cdp.send('Runtime.evaluate', {
                expression: script,
                awaitPromise: true,
                returnByValue: true
            });
        } catch (e) {
            // CDP connection dropped or evaluation failed fundamentally mid-flight.
            // We must strictly clean up the active StreamListener so it doesn't leak into the next request.
            await streamHandle.cleanup();
            throw e;
        }

        const submitVal = submitRes?.result?.value ?? submitRes?.value;

        if (submitVal === "ABORTED") {
            await streamHandle.cleanup();
            return null;
        }

        if (submitVal !== "SUCCESS") {
            await streamHandle.cleanup();
            throw new Error(`Failed to submit prompt: ${submitVal}`);
        }

        // 4. Return handle so caller can await completion
        return streamHandle;
    }
}

export const browserWorker = new BrowserWorker();
