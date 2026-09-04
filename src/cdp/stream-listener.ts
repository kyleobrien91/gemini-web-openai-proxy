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
               if (state.settlingTimeout) {
                   clearTimeout(state.settlingTimeout);
               }
               delete window["__proxyTurn_" + "${turnId}"];
           }
        `;

        try {
            // Await cleanup fully to ensure DOM state is clear before returning lock
            await this.cdp.send('Runtime.evaluate', { expression: cleanupScript, awaitPromise: true });
        } catch (e) {
            // If the connection is already dead, evaluate will fail.
            // When this happens, we invalidate the target ID so the next request is forced to reconnect
            // and perform a full page reset, tearing down any orphaned state left in the browser.
            this.cdp.targetId = null;
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
                    // Malformed payload detected.
                    // We simply ignore unparseable payloads because they could be emitted
                    // by stale or completely unrelated browser execution contexts that somehow
                    // called the global proxy binding. We only reject/act if we can
                    // authoritatively verify the payload belongs to the *current* turn.
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
                    submitInterval: null,
                    settlingTimeout: null
                };
                const state = window['__proxyTurn_${turnId}'];

                const emitTurnPayload = (bindingName, payload) => {
                    const data = JSON.stringify({ turnId: "${turnId}", payload: payload });
                    window[bindingName](data);
                };

                const SELECTOR = document.querySelector('message-content') ? 'message-content' : '.model-response-text';
                const initialCount = document.querySelectorAll(SELECTOR).length;
                let lastText = "";
                let generatingElement = null;

                // Extraction helper with CRLF normalization and structured code-block preservation
                const extractDOMText = (root) => {
                    if (!root) return "";
                    let text = "";
                    
                    const walk = (node, isLastChildOfParent) => {
                        if (!node) return;
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const el = node;
                            
                            // Skip interactive utility buttons (Copy code, Download, etc.)
                            if (el.tagName === 'BUTTON' || el.tagName === 'GEM-ICON-BUTTON' || (el.classList && el.classList.contains('buttons'))) {
                                return;
                            }
                            
                            // Handle code blocks explicitly to preserve language tag and clean indentation
                            if (el.tagName === 'CODE-BLOCK' || (el.classList && el.classList.contains('code-block'))) {
                                const langEl = el.querySelector('.code-block-decoration span, .code-block-decoration');
                                const lang = (langEl ? langEl.textContent || '' : '').trim().toLowerCase();
                                const codeEl = el.querySelector('code[data-test-id="code-content"], pre code, pre');
                                const code = (codeEl ? codeEl.textContent || '' : '').replace(/\\r\\n/g, '\\n');
                                
                                if (text.length > 0 && !text.endsWith('\\n')) text += '\\n';
                                text += '\`\`\`' + lang + '\\n' + code;
                                if (!code.endsWith('\\n')) text += '\\n';
                                
                                // Only close the block fence if subsequent content exists
                                if (!isLastChildOfParent) {
                                    text += '\`\`\`\\n';
                                }
                                return;
                            }
                            
                            const isBlock = /^(P|DIV|H[1-6]|LI|PRE|TR)$/.test(el.tagName);
                            if (isBlock && text.length > 0 && !text.endsWith('\\n')) {
                                text += '\\n';
                            }
                            
                            const children = Array.from(el.childNodes);
                            for (let i = 0; i < children.length; i++) {
                                const isLast = isLastChildOfParent && (i === children.length - 1);
                                walk(children[i], isLast);
                            }
                            
                            if (isBlock && text.length > 0 && !text.endsWith('\\n')) {
                                text += '\\n';
                            }
                            return;
                        }
                        
                        if (node.nodeType === Node.TEXT_NODE) {
                            text += (node.textContent || '').replace(/\\r\\n/g, '\\n');
                        }
                    };
                    
                    walk(root, true);
                    return text.replace(/\\r\\n/g, '\\n');
                };

                // Resilient matching mechanism: fast path, lookback suffix anchor, non-whitespace alignment
                const reconcileStream = (last, current) => {
                    if (!current || current === last) return null;

                    // 1. Fast path: exact prefix match
                    if (current.startsWith(last)) {
                        const diff = current.slice(last.length);
                        return { diff: diff, newText: current };
                    }

                    // Transient shrink/removal during layout reflow
                    if (current.length < last.length) {
                        return null;
                    }

                    // 2. Lookback Suffix Anchor
                    const maxAnchorLen = Math.min(50, last.length);
                    for (let anchorLen = maxAnchorLen; anchorLen >= 10; anchorLen -= 5) {
                        const anchor = last.slice(-anchorLen);
                        const anchorPos = current.lastIndexOf(anchor);
                        if (anchorPos !== -1 && (anchorPos + anchor.length) >= (last.length - 50)) {
                            const continuationIdx = anchorPos + anchor.length;
                            const diff = current.slice(continuationIdx);
                            return { diff: diff, newText: current };
                        }
                    }

                    // 3. Structural Non-Whitespace Alignment
                    const lastNonWs = [];
                    for (let i = 0; i < last.length; i++) {
                        if (!/\\s/.test(last[i])) lastNonWs.push(last[i]);
                    }

                    let lIdx = 0;
                    let cIdx = 0;
                    while (lIdx < lastNonWs.length && cIdx < current.length) {
                        if (/\\s/.test(current[cIdx])) {
                            cIdx++;
                            continue;
                        }
                        if (current[cIdx] === lastNonWs[lIdx]) {
                            lIdx++;
                            cIdx++;
                        } else {
                            // Non-whitespace character mismatch
                            return null;
                        }
                    }

                    if (lIdx === lastNonWs.length) {
                        // Skip over whitespace in current that was already emitted at the end of last
                        let lastTrailingWsLen = 0;
                        while (lastTrailingWsLen < last.length && /\s/.test(last[last.length - 1 - lastTrailingWsLen])) {
                            lastTrailingWsLen++;
                        }
                        let consumedWs = 0;
                        while (consumedWs < lastTrailingWsLen && cIdx < current.length && /\s/.test(current[cIdx])) {
                            cIdx++;
                            consumedWs++;
                        }
                        const diff = current.slice(cIdx);
                        return { diff: diff, newText: current };
                    }

                    return null;
                };

                let mismatchTicks = 0;

                const processMutations = () => {
                    if (state.aborted) return;

                    if (!generatingElement) {
                        const activeSelector = document.querySelector('message-content') ? 'message-content' : SELECTOR;
                        const elements = document.querySelectorAll(activeSelector);
                        if (elements.length > initialCount) {
                             generatingElement = elements[elements.length - 1];
                        }
                    }

                    if (!generatingElement) return;

                    const currentText = extractDOMText(generatingElement);
                    const reconciliation = reconcileStream(lastText, currentText);

                    if (reconciliation) {
                        mismatchTicks = 0;
                        if (state.settlingTimeout) {
                            clearTimeout(state.settlingTimeout);
                            state.settlingTimeout = null;
                        }
                        lastText = reconciliation.newText;
                        if (reconciliation.diff.length > 0) {
                            emitTurnPayload('proxyEmitToken', reconciliation.diff);
                        }
                    } else if (currentText.length > lastText.length) {
                        mismatchTicks++;
                        if (!state.settlingTimeout) {
                            state.settlingTimeout = setTimeout(() => {
                                state.settlingTimeout = null;
                                if (state.aborted || !generatingElement) return;

                                const settledText = extractDOMText(generatingElement);
                                const settledRes = reconcileStream(lastText, settledText);

                                if (settledRes) {
                                    mismatchTicks = 0;
                                    lastText = settledRes.newText;
                                    if (settledRes.diff.length > 0) {
                                        emitTurnPayload('proxyEmitToken', settledRes.diff);
                                    }
                                } else if (settledText.length > lastText.length && mismatchTicks >= 3) {
                                    state.observer.disconnect();
                                    emitTurnPayload('proxyEmitError', "DOM rewrite detected; stream discontinuity. The UI modified already-emitted text prefix.");
                                }
                            }, 800);
                        }
                    }
                };

                state.observer = new MutationObserver(processMutations);
                state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });

                let stableCount = 0;
                let lastStableText = "";
                state.checkDone = setInterval(() => {
                    if (state.aborted) {
                         clearInterval(state.checkDone);
                         return;
                    }

                    if (!generatingElement) {
                        const activeSelector = document.querySelector('message-content') ? 'message-content' : SELECTOR;
                        const elements = document.querySelectorAll(activeSelector);
                        if (elements.length > initialCount) {
                             generatingElement = elements[elements.length - 1];
                        }
                    }

                    if (!generatingElement) return;

                    const sendBtn = document.querySelector('button[aria-label="Send message"], button[aria-label="Send prompt"], button.send-button-container, .send-button button, [data-test-id="send-button"]');
                    const stopBtn = document.querySelector('button[aria-label*="Stop"], button.stop-button, [data-mat-icon-name="stop"], mat-icon[fonticon="stop"]');
                    const dictateBtn = document.querySelector('button[aria-label*="Dictate"], button[aria-label*="mic"]');

                    const isSendReady = sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true' && sendBtn.closest('gem-icon-button')?.getAttribute('aria-disabled') !== 'true';
                    const isGenerating = !!stopBtn;
                    const isInputReady = isSendReady || (Boolean(dictateBtn) && !isGenerating);

                    const currentText = extractDOMText(generatingElement);

                    if (isInputReady && !isGenerating && (lastText.length > 0 || currentText.length > 0) && currentText === lastStableText && currentText.length > 0) {
                         stableCount++;
                         if (stableCount >= 5) {
                             clearInterval(state.checkDone);
                             state.observer.disconnect();
                             if (state.settlingTimeout) clearTimeout(state.settlingTimeout);

                             // Final flush of any pending settled text
                             const finalText = extractDOMText(generatingElement);
                             const finalRes = reconcileStream(lastText, finalText);
                             if (finalRes) {
                                 lastText = finalRes.newText;
                                 if (finalRes.diff.length > 0) {
                                     emitTurnPayload('proxyEmitToken', finalRes.diff);
                                 }
                             }

                             // Ensure any opened code block fence is cleanly closed
                             const backtickCount = (lastText.match(/\\\`\\\`\\\`/g) || []).length;
                             if (backtickCount % 2 !== 0) {
                                 const closeFence = (lastText.endsWith('\\n') ? '' : '\\n') + '\`\`\`\\n';
                                 lastText += closeFence;
                                 emitTurnPayload('proxyEmitToken', closeFence);
                             }

                             emitTurnPayload('proxyEmitComplete', "done");
                         }
                    } else {
                         stableCount = 0;
                         lastStableText = currentText;
                    }
                }, 500);

                return "READY";
            })();
        `;

        const res = await this.cdp.send('Runtime.evaluate', { expression: script, returnByValue: true });
        const resVal = res?.result?.value ?? res?.value;
        if (resVal !== "READY") {
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
