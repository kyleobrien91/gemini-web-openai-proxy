import { CDPConnection } from './connection.js';
import { TabManager } from './tab-manager.js';
import { ModeSwitcher } from './mode-switcher.js';
import { StreamListener, StreamListenerHandle } from './stream-listener.js';

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

        // 3. Submit prompt via DOM automation
        const script = `
            (async function() {
                const state = window['__proxyTurn_${turnId}'];
                if (!state || state.aborted) return "ABORTED";

                const editor = document.querySelector('.ql-editor.textarea[contenteditable="true"]');
                if (!editor) return "EDITOR_NOT_FOUND";

                editor.focus();
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, ${JSON.stringify(prompt)});

                // Wait for the send button to become genuinely usable
                return new Promise((resolve) => {
                    let attempts = 0;
                    const maxAttempts = 50; // 50 * 100ms = 5 seconds max wait

                    state.submitInterval = setInterval(() => {
                        if (state.aborted) {
                            clearInterval(state.submitInterval);
                            resolve("ABORTED");
                            return;
                        }

                        attempts++;
                        const submitBtn = document.querySelector('button[aria-label="Send prompt"], button.send-button-container');

                        // Strict usability check: exists, visible, not disabled, no aria-disabled
                        const isVisible = submitBtn && submitBtn.offsetParent !== null && submitBtn.getBoundingClientRect().height > 0;
                        const isEnabled = submitBtn && !submitBtn.disabled && submitBtn.getAttribute('aria-disabled') !== 'true';

                        if (isVisible && isEnabled) {
                            clearInterval(state.submitInterval);
                            submitBtn.click();
                            resolve("SUCCESS");
                        } else if (attempts >= maxAttempts) {
                            clearInterval(state.submitInterval);
                            resolve("SUBMIT_BTN_NOT_USABLE_OR_TIMEOUT");
                        }
                    }, 100);
                });
            })();
        `;

        const submitRes = await this.cdp.send('Runtime.evaluate', {
            expression: script,
            awaitPromise: true,
            returnByValue: true
        });

        if (submitRes && submitRes.value === "ABORTED") {
            await streamHandle.cleanup();
            return null;
        }

        if (submitRes && submitRes.value !== "SUCCESS") {
            await streamHandle.cleanup();
            throw new Error(`Failed to submit prompt: ${submitRes.value}`);
        }

        // 4. Return handle so caller can await completion
        return streamHandle;
    }
}

export const browserWorker = new BrowserWorker();
