import { CDPConnection } from './connection.js';

export class StreamListener {
  private cdp: CDPConnection;

  constructor(cdp: CDPConnection) {
    this.cdp = cdp;
  }

  async listen(onToken: (token: string) => void, signal?: AbortSignal): Promise<void> {
    try {
        await this.cdp.send('Runtime.addBinding', { name: 'proxyEmitToken' });
    } catch (e) {
        // Ignore if binding already exists
    }

    try {
        await this.cdp.send('Runtime.addBinding', { name: 'proxyEmitComplete' });
    } catch (e) {
        // Ignore if binding already exists
    }

    let bindingHandler: (event: any) => void;

    return new Promise((resolve, reject) => {
      let cleanup: () => void;

      const onAbort = () => {
          cleanup();
          reject(new Error("Request cancelled"));
      };

      if (signal) {
          if (signal.aborted) {
              return reject(new Error("Request already cancelled"));
          }
          signal.addEventListener('abort', onAbort);
      }

      const onDisconnect = () => {
         cleanup();
         reject(new Error("CDP WebSocket disconnected during stream"));
      };
      this.cdp.onDisconnect(onDisconnect);

      cleanup = () => {
         this.cdp.off('Runtime.bindingCalled', bindingHandler);
         this.cdp.offDisconnect(onDisconnect);
         if (signal) signal.removeEventListener('abort', onAbort);

         const cleanupScript = `
            if (window.__proxyObserver) {
                window.__proxyObserver.disconnect();
            }
            if (window.__proxyCheckDone) {
                clearInterval(window.__proxyCheckDone);
            }
            window.__proxyObserverStarted = false;
         `;
         // We do not await this, and we swallow errors because the connection might already be closed
         this.cdp.send('Runtime.evaluate', { expression: cleanupScript }).catch(() => {});
      };

      bindingHandler = (event: any) => {
        if (event.name === 'proxyEmitToken') {
          onToken(event.payload);
        } else if (event.name === 'proxyEmitComplete') {
          cleanup();
          resolve();
        }
      };

      this.cdp.on('Runtime.bindingCalled', bindingHandler);

      // We use a robust script that first identifies the *current* number of responses.
      // We only listen for mutations on the *new* response element that appears.
      // We verify `currentText.startsWith(lastText)` before emitting deltas to handle DOM rerenders.
      const script = `
        (function() {
            if (window.__proxyObserverStarted) return;
            window.__proxyObserverStarted = true;

            const SELECTOR = '.model-response-text, model-response, .response-container-content, message-content';
            const initialCount = document.querySelectorAll(SELECTOR).length;
            let lastText = "";
            let generatingElement = null;

            window.__proxyObserver = new MutationObserver(() => {
                if (!generatingElement) {
                    const elements = document.querySelectorAll(SELECTOR);
                    if (elements.length > initialCount) {
                         generatingElement = elements[elements.length - 1];
                    }
                }

                if (generatingElement) {
                    const currentText = generatingElement.innerText || generatingElement.textContent || "";
                    if (currentText.length > lastText.length) {
                        if (currentText.startsWith(lastText)) {
                             const diff = currentText.substring(lastText.length);
                             lastText = currentText;
                             window.proxyEmitToken(diff);
                        } else {
                             // DOM rerender shifted text completely. We emit the entire new string
                             // Note: In strict SSE this could duplicate output to client if we don't clear client side,
                             // but it's the safest way to ensure no data is lost on a massive rerender.
                             // More sophisticated diffing could go here. For now, we sync state.
                             window.proxyEmitToken(currentText.substring(lastText.length)); // Try a naive continuation or accept some duplication
                             lastText = currentText;
                        }
                    }
                }
            });
            window.__proxyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

            let stableCount = 0;
            window.__proxyCheckDone = setInterval(() => {
                // If we haven't even found the generation element yet, keep waiting
                if (!generatingElement) return;

                const sendBtn = document.querySelector('button[aria-label="Send prompt"], button.send-button-container');

                // Fallback completion heuristic: button enabled and text has stopped changing for 2 ticks (1 sec)
                if (sendBtn && !sendBtn.disabled && lastText.length > 0) {
                     stableCount++;
                     if (stableCount >= 2) {
                         clearInterval(window.__proxyCheckDone);
                         window.__proxyObserver.disconnect();
                         window.__proxyObserverStarted = false;
                         window.proxyEmitComplete("done");
                     }
                } else {
                     stableCount = 0;
                }
            }, 500);
        })();
      `;
      this.cdp.send('Runtime.evaluate', { expression: script }).catch((e) => {
          cleanup();
          reject(e);
      });
    });
  }
}
