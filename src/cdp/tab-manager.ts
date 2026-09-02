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

    // We already discovered a gemini tab in connection.ts, we just need to reset its state
    // for a clean run if requested.
    await this.resetChatSession();
  }

  async resetChatSession(): Promise<void> {
     return new Promise<void>(async (resolve, reject) => {
         let timeoutId: NodeJS.Timeout;
         let expectedLoaderId: string | null = null;
         let expectedFrameId: string | null = null;

         const lifecycleHandler = (event: any) => {
             // We only care about events matching the exact navigation we just initiated
             if (expectedLoaderId && event.loaderId !== expectedLoaderId) return;
             if (expectedFrameId && event.frameId !== expectedFrameId) return;

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

         // 3. (Waiting happens via the promise resolution from lifecycleHandler)
     }).then(async () => {
         // Give SPA a moment to render after load
         await new Promise(r => setTimeout(r, 1000));
     });
  }
}
