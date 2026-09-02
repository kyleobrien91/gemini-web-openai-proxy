import { CDPConnection } from './connection.js';
import { TabManager } from './tab-manager.js';
import { ModeSwitcher } from './mode-switcher.js';
import { StreamListener } from './stream-listener.js';

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

    async initialize() {
        const target = await this.cdp.discoverTarget();
        await this.cdp.connect(target.webSocketDebuggerUrl);
        await this.tabManager.ensureGeminiTab();
    }

    async submitPrompt(prompt: string, model: string, onToken: (token: string) => void): Promise<void> {
        // 1. Switch mode
        await this.modeSwitcher.switchMode(model);

        // 2. Submit prompt via DOM automation
        const script = `
            (async function() {
                const editor = document.querySelector('.ql-editor.textarea[contenteditable="true"]');
                if (editor) {
                    // Using textContent to avoid raw HTML injection issues if not formatted
                    editor.innerHTML = "";
                    editor.innerText = ${JSON.stringify(prompt)};
                    editor.dispatchEvent(new Event('input', { bubbles: true }));
                    await new Promise(r => setTimeout(r, 100));

                    const submitBtn = document.querySelector('button[aria-label="Send prompt"]');
                    if (submitBtn) {
                        submitBtn.click();
                    }
                }
            })();
        `;

        await this.cdp.send('Runtime.evaluate', {
            expression: script,
            awaitPromise: true
        });

        // 3. Listen for response stream via the stream listener
        await this.streamListener.listen(onToken);
    }
}

export const browserWorker = new BrowserWorker();
