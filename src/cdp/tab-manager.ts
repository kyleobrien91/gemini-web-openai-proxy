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
     // Check if the tab is already on gemini.google.com
     let currentUrl = '';
     try {
       const urlCheck = await this.cdp.send('Runtime.evaluate', {
         expression: 'window.location.href',
         returnByValue: true
       });
       currentUrl = urlCheck?.result?.value || '';
     } catch (e) {
       // Ignore error reading URL
     }

     // Only perform hard Page.navigate if we are not already on Gemini
     if (!currentUrl.includes('gemini.google.com')) {
       await this.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true });

       await new Promise<void>(async (resolve, reject) => {
           let timeoutId: NodeJS.Timeout;
           let expectedLoaderId: string | null = null;
           let expectedFrameId: string | null = null;
           let hasNavigated = false;

           const pendingEvents: any[] = [];

           const lifecycleHandler = (event: any) => {
               if (!hasNavigated) {
                   pendingEvents.push(event);
                   return;
               }
               processLifecycleEvent(event);
           };

           const processLifecycleEvent = (event: any) => {
               if (expectedLoaderId && event.loaderId !== expectedLoaderId) return;
               if (expectedFrameId && event.frameId !== expectedFrameId) return;

               if (event.name === 'load' || event.name === 'DOMContentLoaded' || event.name === 'networkAlmostIdle') {
                   cleanup();
                   resolve();
               }
           };

           const cleanup = () => {
               clearTimeout(timeoutId);
               this.cdp.off('Page.lifecycleEvent', lifecycleHandler);
           };

           this.cdp.on('Page.lifecycleEvent', lifecycleHandler);

           // Setup timeout
           timeoutId = setTimeout(() => {
               cleanup();
               reject(new Error("Timeout waiting for Page.lifecycleEvent 'load' during resetChatSession"));
           }, 10000);

           try {
               const res = await this.cdp.send('Page.navigate', { url: 'https://gemini.google.com/app' });
               if (res.errorText) {
                   cleanup();
                   return reject(new Error(`Page navigation failed: ${res.errorText}`));
               }

               if (!res.loaderId) {
                   cleanup();
                   return resolve();
               }

               expectedLoaderId = res.loaderId;
               expectedFrameId = res.frameId;
               hasNavigated = true;

               for (const event of pendingEvents) {
                   processLifecycleEvent(event);
               }
           } catch (e) {
               cleanup();
               return reject(e);
           }
       });

       await new Promise(r => setTimeout(r, 1000));
     }

      // Trigger "New chat" to clear previous history and establish a clean session
      const script = `
        (async function() {
           const findNewChatBtn = () => {
             return document.querySelector(
               'button[aria-label="New chat"], a[href="/app"], a[aria-label="New chat"], [data-test-id="side-nav-sparkle-button"], [data-test-id="new-chat-button"]'
             );
           };

           const getResponseCount = () => {
             return document.querySelectorAll('.model-response-text, [data-test-id="model-response-text"], message-content').length;
           };

           if (getResponseCount() === 0 && (window.location.pathname === '/app' || window.location.pathname === '/')) {
             return "SUCCESS";
           }

           let btn = findNewChatBtn();
           if (!btn) {
             const start = Date.now();
             while (Date.now() - start < 3000) {
               await new Promise(r => setTimeout(r, 200));
               btn = findNewChatBtn();
               if (btn) break;
             }
           }

           if (!btn) {
             return "NEW_CHAT_BUTTON_NOT_FOUND";
           }

           btn.click();

           const clearStart = Date.now();
           while (Date.now() - clearStart < 5000) {
             await new Promise(r => setTimeout(r, 250));
             if (getResponseCount() === 0) {
               return "SUCCESS";
             }
           }

           return "CHAT_RESET_VERIFICATION_FAILED";
        })();
      `;

      const resetRes = await this.cdp.send('Runtime.evaluate', {
          expression: script,
          awaitPromise: true,
          returnByValue: true
      });

      const resetVal = resetRes?.result?.value ?? resetRes?.value;
      if (!resetRes || resetVal !== "SUCCESS") {
          throw new Error(`Failed to initialize and verify a new conversation in Gemini UI: ${resetVal || 'unknown error'}`);
      }
  }
}
