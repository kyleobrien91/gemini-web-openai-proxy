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

         const loadHandler = () => {
             cleanup();
             resolve();
         };

         const cleanup = () => {
             clearTimeout(timeoutId);
             this.cdp.off('Page.loadEventFired', loadHandler);
         };

         // 1. Register listener BEFORE navigation
         this.cdp.on('Page.loadEventFired', loadHandler);

         // Setup timeout
         timeoutId = setTimeout(() => {
             cleanup();
             reject(new Error("Timeout waiting for Page.loadEventFired during resetChatSession"));
         }, 10000);

         // 2. Initiate navigation
         try {
             await this.cdp.send('Page.navigate', { url: 'https://gemini.google.com/app' });
         } catch (e) {
             cleanup();
             return reject(e);
         }

         // 3. (Waiting happens via the promise resolution from loadHandler)
     }).then(async () => {
         // Give SPA a moment to render after load
         await new Promise(r => setTimeout(r, 1000));
     });
  }
}
