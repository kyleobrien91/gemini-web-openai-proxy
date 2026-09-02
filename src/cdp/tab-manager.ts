import { CDPConnection } from './connection.js';

export class TabManager {
  private cdp: CDPConnection;
  private targetId: string | null = null;
  private sessionId: string | null = null;

  constructor(cdp: CDPConnection) {
    this.cdp = cdp;
  }

  async ensureGeminiTab(): Promise<void> {
    const target = await this.cdp.discoverTarget();

    // We attach to the target via the browser target or directly, for simplicity we use the ws url directly in connection.ts
    // but here we manage the tab state

    const { url } = await this.cdp.send('Target.getTargetInfo', { targetId: target.id });

    if (!url.includes('gemini.google.com/app')) {
      await this.cdp.send('Page.navigate', { url: 'https://gemini.google.com/app' });
      // Wait for page to load
      await new Promise<void>((resolve) => {
         const loadHandler = () => {
             this.cdp.off('Page.loadEventFired', loadHandler);
             resolve();
         };
         this.cdp.on('Page.loadEventFired', loadHandler);
      });
    } else {
        // Reset chat session to ensure stateless mode
        await this.resetChatSession();
    }
  }

  async resetChatSession(): Promise<void> {
     // A simple way to reset is to reload or navigate to the base app url
     await this.cdp.send('Page.navigate', { url: 'https://gemini.google.com/app' });
     await new Promise(resolve => setTimeout(resolve, 2000)); // Give it time to render
  }
}
