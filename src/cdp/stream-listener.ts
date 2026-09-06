import type { RequestTrace } from "../utils/request-trace.js";
import type { CDPConnection } from "./connection.js";

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
			await this.cdp.send("Runtime.addBinding", { name });
		} catch (e: any) {
			if (
				e.message &&
				(e.message.includes("Binding already exists") ||
					e.message.includes("Binding with that name already exists"))
			) {
				// Safe to ignore
			} else {
				throw e; // Rethrow actual CDP failures
			}
		}
	}

	// Setup returns a handle. Setup must be awaited before submitting the prompt.
	async setup(
		turnId: string,
		onToken: (token: string) => void,
		signal?: AbortSignal,
		trace?: RequestTrace,
	): Promise<StreamListenerHandle> {
		let bindingHandler: ((event: any) => void) | undefined;
		let onDisconnect: (() => void) | undefined;
		let onAbort: (() => void) | undefined;

		// Transactional cleanup tracking
		let isSetup = false;
		let isCleanedUp = false;

		const rollback = async () => {
			if (isCleanedUp) return;
			isCleanedUp = true;

			if (bindingHandler) this.cdp.off("Runtime.bindingCalled", bindingHandler);
			if (onDisconnect) this.cdp.offDisconnect(onDisconnect);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);

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
				await this.cdp.send("Runtime.evaluate", {
					expression: cleanupScript,
					awaitPromise: true,
				});
			} catch (_e) {
				// If the connection is already dead, evaluate will fail.
				// When this happens, we invalidate the target ID so the next request is forced to reconnect
				// and perform a full page reset, tearing down any orphaned state left in the browser.
				this.cdp.targetId = null;
			}
		};

		try {
			await this.safeAddBinding("proxyEmitToken");
			await this.safeAddBinding("proxyEmitComplete");
			await this.safeAddBinding("proxyEmitError");

			const completionPromise = new Promise<void>((resolve, reject) => {
				onAbort = () => {
					rollback().then(() => reject(new Error("Request cancelled")));
				};

				if (signal) {
					if (signal.aborted) {
						return reject(new Error("Request already cancelled"));
					}
					signal.addEventListener("abort", onAbort);
				}

				onDisconnect = () => {
					rollback().then(() =>
						reject(new Error("CDP WebSocket disconnected during stream")),
					);
				};
				this.cdp.onDisconnect(onDisconnect);

				bindingHandler = (event: any) => {
					if (
						event.name === "proxyEmitToken" ||
						event.name === "proxyEmitError" ||
						event.name === "proxyEmitComplete"
					) {
						let parsedPayload: any;
						try {
							parsedPayload = JSON.parse(event.payload);
						} catch (_e) {
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

						if (event.name === "proxyEmitToken") {
							trace?.recordToken();
							onToken(parsedPayload.payload);
						} else if (event.name === "proxyEmitError") {
							rollback().then(() => reject(new Error(parsedPayload.payload)));
						} else if (event.name === "proxyEmitComplete") {
							rollback().then(() => resolve());
						}
					}
				};

				this.cdp.on("Runtime.bindingCalled", bindingHandler);
			});

			const script = this.buildBrowserStreamScript(turnId);
			const res = await this.cdp.send("Runtime.evaluate", {
				expression: script,
				returnByValue: true,
			});
			const resVal = res?.result?.value ?? res?.value;
			if (resVal !== "READY") {
				throw new Error("StreamListener failed to setup DOM observer.");
			}

			isSetup = true;

			return {
				waitForCompletion: () => completionPromise,
				cleanup: rollback,
			};
		} catch (e) {
			await rollback();
			throw e;
		}
	}

	private buildBrowserStreamScript(turnId: string): string {
    return `
      (function() {
        const stateKey = '__proxyTurn_${turnId}';
        window[stateKey] = {
            aborted: false,
            observer: null,
            checkDone: null,
            submitInterval: null
        };
        const state = window[stateKey];

        const emitTurnPayload = (bindingName, payload) => {
            const data = JSON.stringify({ turnId: "${turnId}", payload: payload });
            window[bindingName](data);
        };

        const SELECTOR = 'model-response';
        const initialCount = document.querySelectorAll(SELECTOR).length;
        let generatingElement = null;
        let lastCanonical = '';

        function domToMarkdown(root) {
            const lines = [];

            function normaliseText(value) {
                return value
                    .replace(/\\r\\n/g, '\\n')
                    .replace(/\\r/g, '\\n')
                    .replace(/[ \\t]+\\n/g, '\\n')
                    .replace(/\\n[ \\t]+/g, '\\n');
            }

            function textContent(node) {
                return normaliseText(node.textContent || '');
            }

            function renderInline(node) {
                if (node.nodeType === Node.TEXT_NODE) {
                    return node.textContent || '';
                }
                if (node.nodeType !== Node.ELEMENT_NODE) {
                    return '';
                }
                const el = node;
                const tag = el.tagName.toLowerCase();
                if (tag === 'br') {
                    return '\\n';
                }
                if (tag === 'code' && el.parentElement?.tagName.toLowerCase() !== 'pre') {
                    return '\`' + textContent(el) + '\`';
                }
                if (tag === 'strong' || tag === 'b') {
                    return '**' + Array.from(el.childNodes).map(renderInline).join('') + '**';
                }
                if (tag === 'em' || tag === 'i') {
                    return '*' + Array.from(el.childNodes).map(renderInline).join('') + '*';
                }
                if (tag === 'del' || tag === 's' || tag === 'strike') {
                    return '~~' + Array.from(el.childNodes).map(renderInline).join('') + '~~';
                }
                if (tag === 'a') {
                    const href = el.getAttribute('href');
                    const text = Array.from(el.childNodes).map(renderInline).join('');
                    return href ? ('[' + text + '](' + href + ')') : text;
                }
                return Array.from(el.childNodes).map(renderInline).join('');
            }

            function renderBlock(node, depth = 0) {
                if (node.nodeType === Node.TEXT_NODE) {
                    const value = (node.textContent || '')
                        .replace(/\\r\\n/g, '\\n')
                        .replace(/\\r/g, '\\n');
                    if (value.trim().length > 0) {
                        lines.push(value.trim());
                    }
                    return;
                }
                if (node.nodeType !== Node.ELEMENT_NODE) {
                    return;
                }
                const el = node;
                const tag = el.tagName.toLowerCase();
                if (tag === 'pre') {
                    const code = el.querySelector('code');
                    const source = code ? (code.textContent || '') : (el.textContent || '');
                    const className = code?.className || '';
                    const languageMatch = className.match(
                        /(?:language|lang)-([a-z0-9_+-]+)/i
                    );
                    lines.push(
                        '\`\`\`' + (languageMatch ? languageMatch[1] : '')
                    );
                    lines.push(
                        source
                            .replace(/\\r\\n/g, '\\n')
                            .replace(/\\r/g, '\\n')
                            .replace(/\\n$/, '')
                    );
                    lines.push('\`\`\`');
                    lines.push('');
                    return;
                }
                if (/^h[1-6]$/.test(tag)) {
                    const level = Number(tag.substring(1));
                    lines.push('#'.repeat(level) + ' ' + renderInline(el).trim());
                    lines.push('');
                    return;
                }
                if (tag === 'blockquote') {
                    const content = renderInline(el)
                        .replace(/\\r\\n/g, '\\n')
                        .replace(/\\r/g, '\\n');
                    for (const line of content.split('\\n')) {
                        lines.push('> ' + line);
                    }
                    lines.push('');
                    return;
                }
                if (tag === 'ul' || tag === 'ol') {
                    const items = Array.from(el.children)
                        .filter(child => child.tagName.toLowerCase() === 'li');
                    items.forEach((item, index) => {
                        const prefix = tag === 'ol' ? ((index + 1) + '. ') : '- ';
                        const itemText = renderInline(item).trim();
                        lines.push(prefix + itemText);
                    });
                    lines.push('');
                    return;
                }
                if (tag === 'li') {
                    lines.push(renderInline(el).trim());
                    return;
                }
                if (tag === 'hr') {
                    lines.push('---');
                    lines.push('');
                    return;
                }
                if (tag === 'p') {
                    const content = renderInline(el)
                        .replace(/\\r\\n/g, '\\n')
                        .replace(/\\r/g, '\\n')
                        .replace(/[ \\t]+\\n/g, '\\n')
                        .replace(/\\n{3,}/g, '\\n\\n')
                        .trim();
                    if (content.length > 0) {
                        lines.push(content);
                        lines.push('');
                    }
                    return;
                }

                // Recursively process children of container elements (div, message-content, section, etc.)
                for (const child of Array.from(el.childNodes)) {
                    renderBlock(child, depth + 1);
                }
            }

            const contentRoot = root.querySelector('message-content') || 
                                root.querySelector('.model-response-text') || 
                                root.querySelector('.response-content') || 
                                root;

            renderBlock(contentRoot);
            let result = lines.join('\\n');
            result = result
                .replace(/\\r\\n/g, '\\n')
                .replace(/\\r/g, '\\n')
                .replace(/[ \\t]+\\n/g, '\\n')
                .replace(/\\n{3,}/g, '\\n\\n')
                .replace(/[ \\t]+$/gm, '')
                .trim();
            return result;
        }

        function emitCanonicalDelta(currentCanonical) {
            if (!currentCanonical) return;
            if (!lastCanonical) {
                lastCanonical = currentCanonical;
                emitTurnPayload('proxyEmitToken', currentCanonical);
                return;
            }
            if (currentCanonical === lastCanonical) return;

            if (currentCanonical.startsWith(lastCanonical)) {
                const delta = currentCanonical.substring(lastCanonical.length);
                lastCanonical = currentCanonical;
                if (delta.length > 0) {
                    emitTurnPayload('proxyEmitToken', delta);
                }
                return;
            }

            // Reconciliation path: find common prefix
            let commonPrefix = 0;
            const max = Math.min(lastCanonical.length, currentCanonical.length);
            while (
                commonPrefix < max &&
                lastCanonical.charCodeAt(commonPrefix) === currentCanonical.charCodeAt(commonPrefix)
            ) {
                commonPrefix++;
            }

            const rewriteDistance = lastCanonical.length - commonPrefix;
            if (rewriteDistance <= 256) {
                const delta = currentCanonical.substring(commonPrefix);
                lastCanonical = currentCanonical;
                if (delta.length > 0) {
                    emitTurnPayload('proxyEmitToken', delta);
                }
            }
        }

        function locateGeneratingElement() {
            if (generatingElement) return;
            const elements = document.querySelectorAll(SELECTOR);
            if (elements.length > initialCount) {
                generatingElement = elements[initialCount];
            }
        }

        function sampleResponse() {
            if (state.aborted) return;
            locateGeneratingElement();
            if (!generatingElement) return;
            const canonical = domToMarkdown(generatingElement);
            emitCanonicalDelta(canonical);
        }

        state.observer = new MutationObserver(() => {
            if (state.aborted) return;
            requestAnimationFrame(() => {
                sampleResponse();
            });
        });
        state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        let stableCount = 0;
        let lastObservedLength = 0;

        state.checkDone = setInterval(() => {
            if (state.aborted) {
                clearInterval(state.checkDone);
                return;
            }

            sampleResponse();

            const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Cancel"]');
            const dictateBtn = document.querySelector('button[aria-label*="Dictate"], button[aria-label*="Microphone"]');
            const sendBtn = document.querySelector('button[aria-label*="Send"]');
            const actionBtns = document.querySelector('button[aria-label="Good response"], button[aria-label="Copy"], button[aria-label="Redo"]');

            const currentLength = lastCanonical.length;
            if (currentLength === lastObservedLength && currentLength > 0) {
                stableCount++;
            } else {
                stableCount = 0;
            }
            lastObservedLength = currentLength;

            const isDone = !stopBtn && (Boolean(dictateBtn) || Boolean(sendBtn) || Boolean(actionBtns)) && currentLength > 0;

            if (isDone && stableCount >= 2) {
                clearInterval(state.checkDone);
                if (state.observer) {
                    state.observer.disconnect();
                }
                sampleResponse();
                emitTurnPayload('proxyEmitComplete', "done");
            }
        }, 500);

        return "READY";
      })();
    `;
	}
}
