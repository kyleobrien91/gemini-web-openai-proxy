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
         let hasNavigated = false;

         const pendingEvents: any[] = [];

         const lifecycleHandler = (event: any) => {
             // If we haven't navigated yet, capture events in a buffer to prevent losing fast loads
             if (!hasNavigated) {
                 pendingEvents.push(event);
                 return;
             }

             processLifecycleEvent(event);
         };

         const processLifecycleEvent = (event: any) => {
             // We only care about events matching the exact navigation we just initiated
             // If loaderId is missing from the navigation response, it was a same-document navigation
             // and we shouldn't enforce loaderId matching.
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

             // Same-document navigation (e.g., hash change) might not return a loaderId.
             // In that case, navigation is effectively instantaneous and we don't need to wait for a full load event.
             if (!res.loaderId) {
                 cleanup();
                 return resolve();
             }

             expectedLoaderId = res.loaderId;
             expectedFrameId = res.frameId;
             hasNavigated = true;

             // Process any events that arrived while we were waiting for Page.navigate to resolve
             for (const event of pendingEvents) {
                 processLifecycleEvent(event);
             }
         } catch (e) {
             cleanup();
             return reject(e);
         }
     }).then(async () => {
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
     });
  }
}
