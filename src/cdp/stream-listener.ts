import { CDPConnection } from './connection.js';

export interface StreamListenerHandle {
    waitForCompletion: () => Promise<void>;
}

export class StreamListener {
  private cdp: CDPConnection;

  constructor(cdp: CDPConnection) {
    this.cdp = cdp;
  }

  // Setup returns a handle. Setup must be awaited before submitting the prompt.
  async setup(onToken: (token: string) => void, signal?: AbortSignal): Promise<StreamListenerHandle> {
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

    try {
        await this.cdp.send('Runtime.addBinding', { name: 'proxyEmitError' });
    } catch (e) {
        // Ignore if binding already exists
    }

    let bindingHandler: (event: any) => void;
    let cleanupFunc: () => void;

    const completionPromise = new Promise<void>((resolve, reject) => {

      const onAbort = () => {
          cleanupFunc();
          reject(new Error("Request cancelled"));
      };

      if (signal) {
          if (signal.aborted) {
              return reject(new Error("Request already cancelled"));
          }
          signal.addEventListener('abort', onAbort);
      }

      const onDisconnect = () => {
         cleanupFunc();
         reject(new Error("CDP WebSocket disconnected during stream"));
      };
      this.cdp.onDisconnect(onDisconnect);

      cleanupFunc = () => {
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
         this.cdp.send('Runtime.evaluate', { expression: cleanupScript }).catch(() => {});
      };

      bindingHandler = (event: any) => {
        if (event.name === 'proxyEmitToken') {
          onToken(event.payload);
        } else if (event.name === 'proxyEmitError') {
          cleanupFunc();
          reject(new Error(event.payload));
        } else if (event.name === 'proxyEmitComplete') {
          cleanupFunc();
          resolve();
        }
      };

      this.cdp.on('Runtime.bindingCalled', bindingHandler);
    });

    // Inject the observer now, so we are guaranteed it is active BEFORE this setup resolves
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
                             // DOM rerender shifted text completely. Fail the stream to prevent corruption.
                             window.__proxyObserver.disconnect();
                             window.__proxyObserverStarted = false;
                             window.proxyEmitError("DOM rewrite detected; stream discontinuity. The UI modified already-emitted text prefix.");
                        }
                    }
                }
            });
            window.__proxyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

            let stableCount = 0;
            window.__proxyCheckDone = setInterval(() => {
                if (!generatingElement) return;

                const sendBtn = document.querySelector('button[aria-label="Send prompt"], button.send-button-container');

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

            return "READY";
        })();
    `;

    const res = await this.cdp.send('Runtime.evaluate', { expression: script, returnByValue: true });
    if (res?.value !== "READY") {
         throw new Error("StreamListener failed to setup DOM observer.");
    }

    // We are fully set up.
    return {
        waitForCompletion: () => completionPromise
    };
  }
}
