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
                const extractDOMText = (root, isFinal = false) => {
                    if (!root) return "";
                    let text = "";
                    let openCodeBlock = false;

                    const closeCodeBlockIfNeeded = () => {
                        if (openCodeBlock) {
                            if (text.length > 0 && !text.endsWith('\\n')) text += '\\n';
                            text += '\`\`\`\\n';
                            openCodeBlock = false;
                        }
                    };
                    
                    const walk = (node) => {
                        if (!node) return;
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const el = node;
                            
                            // Skip interactive utility buttons (Copy code, Download, etc.)
                            if (el.tagName === 'BUTTON' || el.tagName === 'GEM-ICON-BUTTON' || (el.classList && el.classList.contains('buttons'))) {
                                return;
                            }

                            // Preserve hard line breaks inside paragraphs or text
                            if (el.tagName === 'BR') {
                                closeCodeBlockIfNeeded();
                                text += '\\n';
                                return;
                            }
                            
                            // Handle code blocks explicitly to preserve language tag and clean indentation
                            if (el.tagName === 'CODE-BLOCK' || (el.classList && el.classList.contains('code-block'))) {
                                closeCodeBlockIfNeeded();
                                const langEl = el.querySelector('.code-block-decoration span, .code-block-decoration');
                                const lang = (langEl ? langEl.textContent || '' : '').trim().toLowerCase();
                                const codeEl = el.querySelector('code[data-test-id="code-content"]') || el.querySelector('pre code') || el.querySelector('pre');
                                const code = (codeEl ? codeEl.textContent || '' : '').replace(/\\r\\n|\\r/g, '\\n');
                                
                                if (text.length > 0 && !text.endsWith('\\n')) text += '\\n';
                                text += '\`\`\`' + lang + '\\n' + code;
                                openCodeBlock = true;
                                return;
                            }
                            
                            const isBlock = /^(P|DIV|H[1-6]|LI|PRE|TR|UL|OL|BLOCKQUOTE|TABLE)$/.test(el.tagName);
                            if (isBlock) {
                                closeCodeBlockIfNeeded();
                                if (text.length > 0 && !text.endsWith('\\n')) {
                                    text += '\\n';
                                }
                            }
                            
                            const children = Array.from(el.childNodes);
                            for (let i = 0; i < children.length; i++) {
                                walk(children[i]);
                            }
                            
                            if (isBlock && text.length > 0 && !text.endsWith('\\n')) {
                                text += '\\n';
                            }
                            return;
                        }
                        
                        if (node.nodeType === Node.TEXT_NODE) {
                            const content = (node.textContent || '').replace(/\\r\\n|\\r/g, '\\n');
                            if (content.trim().length > 0) {
                                closeCodeBlockIfNeeded();
                            }
                            text += content;
                        }
                    };
                    
                    walk(root);
                    if (isFinal) {
                        closeCodeBlockIfNeeded();
                    }
                    return text.replace(/\\r\\n|\\r/g, '\\n');
                };

                // Resilient matching mechanism: fast path, lookback suffix anchor, non-whitespace alignment
                const reconcileStream = (last, current) => {
                    if (!current || current === last) return null;

                    // 1. Fast path: exact prefix match
                    if (current.startsWith(last)) {
                        const diff = current.slice(last.length);
                        return { diff: diff, newText: current };
                    }

                    // 2. Lookback Suffix Anchor
                    const maxAnchorLen = Math.min(50, last.length);
                    for (let anchorLen = maxAnchorLen; anchorLen >= 10; anchorLen -= 5) {
                        const anchor = last.slice(-anchorLen);
                        if (anchor.trim().length < 3) continue;
                        const anchorPos = current.lastIndexOf(anchor);
                        if (anchorPos !== -1 && (anchorPos + anchor.length) >= Math.max(0, last.length - 150)) {
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
                        // Analyze trailing whitespace in last
                        let lastTrailingWs = "";
                        let p = last.length - 1;
                        while (p >= 0 && /\\s/.test(last[p])) {
                            lastTrailingWs = last[p] + lastTrailingWs;
                            p--;
                        }

                        let lastNlCount = (lastTrailingWs.match(/\\n/g) || []).length;
                        let lastIndentLen = 0;
                        if (lastNlCount > 0) {
                            const lastNlIdx = lastTrailingWs.lastIndexOf('\\n');
                            lastIndentLen = lastTrailingWs.length - 1 - lastNlIdx;
                        } else {
                            lastIndentLen = lastTrailingWs.length;
                        }

                        // Consume matching whitespace in current without swallowing newlines
                        let consumedNls = 0;
                        if (lastNlCount > 0) {
                            while (cIdx < current.length && consumedNls < lastNlCount) {
                                if (current[cIdx] === '\\n') {
                                    consumedNls++;
                                    cIdx++;
                                } else if (/\\s/.test(current[cIdx])) {
                                    cIdx++;
                                } else {
                                    break;
                                }
                            }
                            let consumedIndent = 0;
                            while (cIdx < current.length && current[cIdx] !== '\\n' && /\\s/.test(current[cIdx]) && consumedIndent < lastIndentLen) {
                                cIdx++;
                                consumedIndent++;
                            }
                        } else {
                            let consumedIndent = 0;
                            while (cIdx < current.length && current[cIdx] !== '\\n' && /\\s/.test(current[cIdx]) && consumedIndent < lastIndentLen) {
                                cIdx++;
                                consumedIndent++;
                            }
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
                        } else if (elements.length > 0 && elements[elements.length - 1].textContent?.trim()) {
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
                    } else if (currentText !== lastText) {
                        if (state.settlingTimeout) {
                            clearTimeout(state.settlingTimeout);
                        }
                        const scheduleSettling = () => {
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
                                } else if (settledText !== lastText) {
                                    mismatchTicks++;
                                    if (mismatchTicks >= 3) {
                                        state.observer.disconnect();
                                        emitTurnPayload('proxyEmitError', "DOM rewrite detected; stream discontinuity. The UI modified already-emitted text prefix.");
                                    } else {
                                        scheduleSettling();
                                    }
                                }
                            }, 500);
                        };
                        scheduleSettling();
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
                        } else if (elements.length > 0 && elements[elements.length - 1].textContent?.trim()) {
                             generatingElement = elements[elements.length - 1];
                        }
                    }

                    if (!generatingElement) return;

                    const sendBtn = document.querySelector('button[aria-label="Send message" i], button[aria-label="Send prompt" i], button.send-button-container, .send-button button, [data-test-id="send-button"]');
                    const stopBtn = document.querySelector('button[aria-label*="stop" i], button.stop-button, [data-mat-icon-name="stop"], mat-icon[fonticon="stop"]');
                    const dictateBtn = document.querySelector('button[aria-label*="dictate" i], button[aria-label*="mic" i]');

                    const isSendReady = sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true' && !sendBtn.closest('[aria-disabled="true"]');
                    const isGenerating = !!stopBtn;
                    const isInputReady = isSendReady || (Boolean(dictateBtn) && !isGenerating);

                    const currentText = extractDOMText(generatingElement);

                    if (isInputReady && !isGenerating && (lastText.length > 0 || currentText.length > 0) && currentText === lastStableText && currentText.length > 0) {
                         stableCount++;
                         if (stableCount >= 5) {
                             clearInterval(state.checkDone);
                             state.observer.disconnect();
                             if (state.settlingTimeout) clearTimeout(state.settlingTimeout);

                             // Final flush of any pending settled text with structured code-block closure
                             const finalText = extractDOMText(generatingElement, true);
                             const finalRes = reconcileStream(lastText, finalText);
                             if (finalRes) {
                                 lastText = finalRes.newText;
                                 if (finalRes.diff.length > 0) {
                                     emitTurnPayload('proxyEmitToken', finalRes.diff);
                                 }
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
