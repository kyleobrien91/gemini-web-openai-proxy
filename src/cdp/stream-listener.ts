import { CDPConnection } from './connection.js';

export interface StreamListenerHandle {
    waitForCompletion: () => Promise<void>;
}

export class StreamListener {
  private cdp: CDPConnection;

  constructor(cdp: CDPConnection) {
    this.cdp = cdp;
  }

  private async safeAddBinding(name: string) {
      try {
          await this.cdp.send('Runtime.addBinding', { name });
      } catch (e: any) {
          if (e.message && (e.message.includes('Binding already exists') || e.message.includes('Binding with that name already exists'))) {
              // Safe to ignore
          } else {
              throw e; // Rethrow actual CDP failures
          }
      }
  }

  // Setup returns a handle. Setup must be awaited before submitting the prompt.
  async setup(onToken: (token: string) => void, signal?: AbortSignal): Promise<StreamListenerHandle> {
    let bindingHandler: ((event: any) => void) | undefined;
    let onDisconnect: (() => void) | undefined;
    let onAbort: (() => void) | undefined;

    // Transactional cleanup tracking
    let isSetup = false;

    const rollback = () => {
        if (bindingHandler) this.cdp.off('Runtime.bindingCalled', bindingHandler);
        if (onDisconnect) this.cdp.offDisconnect(onDisconnect);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);

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

    try {
        await this.safeAddBinding('proxyEmitToken');
        await this.safeAddBinding('proxyEmitComplete');
        await this.safeAddBinding('proxyEmitError');

        const completionPromise = new Promise<void>((resolve, reject) => {

          onAbort = () => {
              rollback();
              reject(new Error("Request cancelled"));
          };

          if (signal) {
              if (signal.aborted) {
                  return reject(new Error("Request already cancelled"));
              }
              signal.addEventListener('abort', onAbort);
          }

          onDisconnect = () => {
             rollback();
             reject(new Error("CDP WebSocket disconnected during stream"));
          };
          this.cdp.onDisconnect(onDisconnect);

          bindingHandler = (event: any) => {
            if (event.name === 'proxyEmitToken') {
              onToken(event.payload);
            } else if (event.name === 'proxyEmitError') {
              rollback();
              reject(new Error(event.payload));
            } else if (event.name === 'proxyEmitComplete') {
              rollback();
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
                             // STRICT BINDING: Only attach to the exact next element that appeared
                             generatingElement = elements[initialCount];
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

        isSetup = true;
        // We are fully set up.
        return {
            waitForCompletion: () => completionPromise
        };

    } catch (e) {
        if (!isSetup) {
            rollback();
        }
        throw e;
    }
  }
}
