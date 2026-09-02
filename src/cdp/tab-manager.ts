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
     // Navigate to base app url to clear context
     await this.cdp.send('Page.navigate', { url: 'https://gemini.google.com/app' });

     // Wait for load event
     await new Promise<void>((resolve, reject) => {
         const timeout = setTimeout(() => reject(new Error("Timeout waiting for page load")), 5000);
         const loadHandler = () => {
             clearTimeout(timeout);
             this.cdp.off('Page.loadEventFired', loadHandler);
             resolve();
         };
         this.cdp.on('Page.loadEventFired', loadHandler);
     }).catch(e => console.warn("Page load event warning:", e));

     // Give SPA a moment to render
     await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
