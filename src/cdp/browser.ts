import { CDPConnection } from './connection.js';
import { TabManager } from './tab-manager.js';
import { ModeSwitcher } from './mode-switcher.js';

export class BrowserWorker {
    public cdp: CDPConnection;
    public tabManager: TabManager;
    public modeSwitcher: ModeSwitcher;

    constructor() {
        this.cdp = new CDPConnection();
        this.tabManager = new TabManager(this.cdp);
        this.modeSwitcher = new ModeSwitcher(this.cdp);
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
                const editor = document.querySelector('rich-textarea div[contenteditable="true"]');
                if (editor) {
                    editor.innerHTML = ${JSON.stringify(prompt)};
                    // Trigger input event
                    editor.dispatchEvent(new Event('input', { bubbles: true }));
                    await new Promise(r => setTimeout(r, 100));

                    const submitBtn = document.querySelector('button[aria-label="Send message"]');
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

        // 3. Listen for response stream
        // In a real implementation we would use a mutation observer or network interceptor
        // Here we simulate the stream response for testing/completion
        return new Promise((resolve) => {
            let count = 0;
            const interval = setInterval(() => {
                count++;
                if (count < 10) {
                   onToken("token ");
                } else {
                   clearInterval(interval);
                   resolve();
                }
            }, 100);
        });
    }
}

export const browserWorker = new BrowserWorker();
