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

     // 1. Enable lifecycle events BEFORE registering the listener or promise
     // We await this natively so failures propagate cleanly to the caller without hanging.
     await this.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true });

     await new Promise<void>(async (resolve, reject) => {
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
     });

     // Give SPA a moment to render after load
     await new Promise(r => setTimeout(r, 1000));

     // Force a "New Chat" click and explicitly VERIFY it succeeded by checking that
     // the chat history (model-response-text) is cleared from the DOM.
     const script = `
       (async function() {
          const newChatBtn = document.querySelector('button[aria-label="New chat"], a[href="/app"]');
          if (newChatBtn) {
              newChatBtn.click();
              // Wait for the UI to clear out previous messages
              await new Promise(r => setTimeout(r, 1000));

              // Verify that the chat is actually fresh
              const existingResponses = document.querySelectorAll('.model-response-text, model-response');
              if (existingResponses.length === 0) {
                  return "SUCCESS";
              }
              return "VERIFICATION_FAILED_CHAT_NOT_EMPTY";
          }
          return "NEW_CHAT_BTN_NOT_FOUND";
       })();
     `;
     const resetRes = await this.cdp.send('Runtime.evaluate', {
         expression: script,
         awaitPromise: true,
         returnByValue: true
     });

     if (!resetRes || resetRes.value !== "SUCCESS") {
         throw new Error(`Failed to initialize and verify a new conversation in Gemini UI: ${resetRes ? resetRes.value : 'unknown error'}`);
     }
  }
}
