import { CDPConnection } from './connection.js';

export class TabManager {
  private cdp: CDPConnection;

  constructor(cdp: CDPConnection) {
    this.cdp = cdp;
  }

  async ensureGeminiTab(): Promise<void> {
    if (!this.cdp.targetId) {
        throw new Error("No target ID associated with connection");
    }

    await this.resetChatSession();
  }

  async resetChatSession(): Promise<void> {
     // Navigation alone doesn't clear the Gemini UI state if it's an SPA routing.
     // We will first try to navigate, then ensure the UI has clicked "New chat" to guarantee a fresh slate.
     return new Promise<void>(async (resolve, reject) => {
         let timeoutId: NodeJS.Timeout;
         let expectedLoaderId: string | null = null;
         let expectedFrameId: string | null = null;

         const lifecycleHandler = (event: any) => {
             // Block any events that arrive before we have our expected IDs populated
             if (!expectedLoaderId || !expectedFrameId) return;

             // We only care about events matching the exact navigation we just initiated
             if (event.loaderId !== expectedLoaderId) return;
             if (event.frameId !== expectedFrameId) return;

             if (event.name === 'load') {
                 cleanup();
                 resolve();
             }
         };

         const cleanup = () => {
             clearTimeout(timeoutId);
             this.cdp.off('Page.lifecycleEvent', lifecycleHandler);
         };

         // 1. Enable lifecycle events and register listener BEFORE navigation
         try {
             await this.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true });
         } catch (e) {
             console.warn("Failed to enable Page lifecycle events", e);
         }

         this.cdp.on('Page.lifecycleEvent', lifecycleHandler);

         // Setup timeout
         timeoutId = setTimeout(() => {
             cleanup();
             reject(new Error("Timeout waiting for Page.lifecycleEvent 'load' during resetChatSession"));
         }, 10000);

         // 2. Initiate navigation
         try {
             const res = await this.cdp.send('Page.navigate', { url: 'https://gemini.google.com/app' });
             if (res.errorText) {
                 cleanup();
                 return reject(new Error(`Page navigation failed: ${res.errorText}`));
             }
             expectedLoaderId = res.loaderId;
             expectedFrameId = res.frameId;
         } catch (e) {
             cleanup();
             return reject(e);
         }
     }).then(async () => {
         // Give SPA a moment to render after load
         await new Promise(r => setTimeout(r, 1000));

         // Force a "New Chat" click just in case navigating to /app reloaded an active session state
         const script = `
           (async function() {
              const newChatBtn = document.querySelector('button[aria-label="New chat"], a[href="/app"]');
              if (newChatBtn) {
                  newChatBtn.click();
                  await new Promise(r => setTimeout(r, 500));
              }
           })();
         `;
         await this.cdp.send('Runtime.evaluate', { expression: script, awaitPromise: true }).catch(() => {});
     });
  }
}
