import { CDPConnection } from './connection.js';
import { TabManager } from './tab-manager.js';
import { ModeSwitcher } from './mode-switcher.js';
import { StreamListener } from './stream-listener.js';
import { Mutex } from '../utils/mutex.js';

export class BrowserWorker {
    public cdp: CDPConnection;
    public tabManager: TabManager;
    public modeSwitcher: ModeSwitcher;
    public streamListener: StreamListener;
    private mutex: Mutex = new Mutex();

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

    async submitPrompt(prompt: string, model: string, onToken: (token: string) => void, signal?: AbortSignal, isRetry: boolean = false): Promise<void> {
        let lockedHere = false;
        if (!isRetry) {
             await this.mutex.lock();
             lockedHere = true;
        }
        try {
            if (signal?.aborted) return;

            // Initialization happens inside the lock. We pass isRetry to prevent chat reset.
            await this.initialize(isRetry);
            if (signal?.aborted) return;

            // 1. Switch mode
            await this.modeSwitcher.switchMode(model);
            if (signal?.aborted) return;

            // 2. Setup listener BEFORE submitting, guaranteeing completion of setup
            const streamHandle = await this.streamListener.setup(onToken, signal);

            // 3. Submit prompt via DOM automation
            const script = `
                (async function() {
                    const editor = document.querySelector('.ql-editor.textarea[contenteditable="true"]');
                    if (!editor) return "EDITOR_NOT_FOUND";

                    editor.focus();
                    document.execCommand('selectAll', false, null);
                    document.execCommand('insertText', false, ${JSON.stringify(prompt)});
                    await new Promise(r => setTimeout(r, 150));

                    const submitBtn = document.querySelector('button[aria-label="Send prompt"], button.send-button-container');
                    if (!submitBtn) return "SUBMIT_BTN_NOT_FOUND";

                    submitBtn.click();
                    return "SUCCESS";
                })();
            `;

            const submitRes = await this.cdp.send('Runtime.evaluate', {
                expression: script,
                awaitPromise: true,
                returnByValue: true
            });

            if (submitRes && submitRes.value !== "SUCCESS") {
                throw new Error(`Failed to submit prompt: ${submitRes.value}`);
            }

            // 4. Wait for stream to finish
            await streamHandle.waitForCompletion();
        } finally {
            if (lockedHere) {
                this.mutex.unlock();
            }
        }
    }
}

export const browserWorker = new BrowserWorker();
