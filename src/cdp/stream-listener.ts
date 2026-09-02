import { CDPConnection } from './connection.js';

export interface StreamListenerHandle {
    waitForCompletion: () => Promise<void>;
    cleanup: () => Promise<void>;
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
  async setup(turnId: string, onToken: (token: string) => void, signal?: AbortSignal): Promise<StreamListenerHandle> {
    let bindingHandler: ((event: any) => void) | undefined;
    let onDisconnect: (() => void) | undefined;
    let onAbort: (() => void) | undefined;

    // Transactional cleanup tracking
    let isSetup = false;
    let isCleanedUp = false;

    const rollback = async () => {
        if (isCleanedUp) return;
        isCleanedUp = true;

        if (bindingHandler) this.cdp.off('Runtime.bindingCalled', bindingHandler);
        if (onDisconnect) this.cdp.offDisconnect(onDisconnect);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);

        // Scope all browser-side variables to the specific turnId
        const cleanupScript = `
           const state = window['__proxyTurn_${turnId}'];
           if (state) {
               state.aborted = true;
               if (state.observer) {
                   state.observer.disconnect();
               }
               if (state.checkDone) {
                   clearInterval(state.checkDone);
               }
               if (state.submitInterval) {
                   clearInterval(state.submitInterval);
               }
           }
        `;

        try {
            // Await cleanup fully to ensure DOM state is clear before returning lock
            await this.cdp.send('Runtime.evaluate', { expression: cleanupScript, awaitPromise: true });
        } catch (e) {
            // If the connection is already dead, evaluate will fail, but that's fine
        }
    };

    try {
        await this.safeAddBinding('proxyEmitToken');
        await this.safeAddBinding('proxyEmitComplete');
        await this.safeAddBinding('proxyEmitError');

        const completionPromise = new Promise<void>((resolve, reject) => {

          onAbort = () => {
              rollback().then(() => reject(new Error("Request cancelled")));
          };

          if (signal) {
              if (signal.aborted) {
                  return reject(new Error("Request already cancelled"));
              }
              signal.addEventListener('abort', onAbort);
          }

          onDisconnect = () => {
             rollback().then(() => reject(new Error("CDP WebSocket disconnected during stream")));
          };
          this.cdp.onDisconnect(onDisconnect);

          bindingHandler = (event: any) => {
            if (event.name === 'proxyEmitToken' || event.name === 'proxyEmitError' || event.name === 'proxyEmitComplete') {
                let parsedPayload: any;
                try {
                    parsedPayload = JSON.parse(event.payload);
                } catch (e) {
                    // Malformed payload detected. Since we use a Mutex, any binding payload emitted right now
                    // belongs to the active run. If it's corrupted, we must terminate the generation
                    // deterministically rather than hanging.
                    rollback().then(() => reject(new Error("Corrupted binding payload received: " + event.payload)));
                    return;
                }

                // Discard payloads belonging to stale or future turns
                if (parsedPayload.turnId !== turnId) {
                    return;
                }

                if (event.name === 'proxyEmitToken') {
                  onToken(parsedPayload.payload);
                } else if (event.name === 'proxyEmitError') {
                  rollback().then(() => reject(new Error(parsedPayload.payload)));
                } else if (event.name === 'proxyEmitComplete') {
                  rollback().then(() => resolve());
                }
            }
          };

          this.cdp.on('Runtime.bindingCalled', bindingHandler);
        });

        // Inject the observer now, so we are guaranteed it is active BEFORE this setup resolves
        const script = `
            (function() {
                // Initialize turn-specific state
                window['__proxyTurn_${turnId}'] = {
                    aborted: false,
                    observer: null,
                    checkDone: null,
                    submitInterval: null
                };
                const state = window['__proxyTurn_${turnId}'];

                const emitTurnPayload = (bindingName, payload) => {
                    const data = JSON.stringify({ turnId: "${turnId}", payload: payload });
                    window[bindingName](data);
                };

                const SELECTOR = '.model-response-text, model-response, .response-container-content, message-content';
                const initialCount = document.querySelectorAll(SELECTOR).length;
                let lastText = "";
                let generatingElement = null;

                state.observer = new MutationObserver(() => {
                    if (state.aborted) return;

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
                                 emitTurnPayload('proxyEmitToken', diff);
                            } else {
                                 // DOM rerender shifted text completely. Fail the stream to prevent corruption.
                                 state.observer.disconnect();
                                 emitTurnPayload('proxyEmitError', "DOM rewrite detected; stream discontinuity. The UI modified already-emitted text prefix.");
                            }
                        }
                    }
                });
                state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });

                let stableCount = 0;
                state.checkDone = setInterval(() => {
                    if (state.aborted) {
                         clearInterval(state.checkDone);
                         return;
                    }

                    if (!generatingElement) return;

                    const sendBtn = document.querySelector('button[aria-label="Send prompt"], button.send-button-container');

                    if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true' && lastText.length > 0) {
                         stableCount++;
                         if (stableCount >= 2) {
                             clearInterval(state.checkDone);
                             state.observer.disconnect();
                             emitTurnPayload('proxyEmitComplete', "done");
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

        return {
            waitForCompletion: () => completionPromise,
            cleanup: rollback
        };

    } catch (e) {
        if (!isSetup) {
            await rollback();
        }
        throw e;
    }
  }
}
