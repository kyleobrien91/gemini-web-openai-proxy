import { config } from "../config.js";
import type { UploadableFile } from "../prompt/file-extractor.js";
import { CDPConnection } from "./connection.js";
import { launchBrowser, waitForAuthentication } from "./launcher.js";
import { ModeSwitcher } from "./mode-switcher.js";
import type { RequestTrace } from "../utils/request-trace.js";
import { ScottyUploader } from "./scotty-uploader.js";
import {
	StreamListener,
	type StreamListenerHandle,
} from "./stream-listener.js";
import { type StreamGenerateHandle, StreamService } from "./stream-service.js";
import { TabManager } from "./tab-manager.js";

export type TurnStreamHandle = StreamListenerHandle | StreamGenerateHandle;

export class BrowserWorker {
	public cdp: CDPConnection;
	public tabManager: TabManager;
	public modeSwitcher: ModeSwitcher;
	public streamListener: StreamListener;
	public scottyUploader: ScottyUploader;
	public streamService: StreamService;
	private readyPromise: Promise<void> | null = null;

	constructor() {
		this.cdp = new CDPConnection();
		this.tabManager = new TabManager(this.cdp);
		this.modeSwitcher = new ModeSwitcher(this.cdp);
		this.streamListener = new StreamListener(this.cdp);
		this.scottyUploader = new ScottyUploader(this.cdp);
		this.streamService = new StreamService(this.cdp);

		this.cdp.onDisconnect(() => {
			this.readyPromise = null;
		});
	}

	async ensureReady(trace?: RequestTrace): Promise<void> {
		trace?.start("browser.ensureReady");
		if (this.readyPromise) {
			return this.readyPromise.then(() => trace?.end("browser.ensureReady"));
		}

		this.readyPromise = (async () => {
			if (config.autoLaunchBrowser) {
				await launchBrowser();
			}
			const target = await this.cdp.discoverTarget();
			await this.cdp.connect(target.webSocketDebuggerUrl);
			await waitForAuthentication(this.cdp);
			await this.tabManager.ensureGeminiTab();
		})().catch((err) => {
			this.readyPromise = null;
			throw err;
		});

		return this.readyPromise;
	}

	private async initialize(isRetry: boolean = false, trace?: RequestTrace) {
		await this.ensureReady(trace);
		// Only reset the chat tab if this is a fresh request
		if (!isRetry) {
			trace?.start("tab.ensureGemini");
			await this.tabManager.ensureGeminiTab();
			trace?.end("tab.ensureGemini");
		}
	}

	async submitPrompt(
		turnId: string,
		prompt: string,
		model: string,
		onToken: (token: string) => void,
		signal?: AbortSignal,
		isRetry: boolean = false,
		attachments?: UploadableFile[],
		trace?: RequestTrace,
	): Promise<TurnStreamHandle | null> {
		if (signal?.aborted) return null;

		// Initialization happens inside the route lock. We pass isRetry to prevent chat reset.
		await this.initialize(isRetry, trace);
		if (signal?.aborted) return null;

		// 1. Switch mode
		trace?.start("model.switch");
		await this.modeSwitcher.switchMode(model);
		trace?.end("model.switch");
		if (signal?.aborted) return null;

		// If multimodal attachments are provided, use direct Scotty upload + StreamGenerate transport
		if (attachments && attachments.length > 0) {
			const uploadedBlobs = await this.scottyUploader.uploadAll(
				attachments,
				signal,
			);
			if (signal?.aborted) return null;

			const streamHandle = await this.streamService.streamGenerate(
				turnId,
				{ model, prompt, blobs: uploadedBlobs },
				onToken,
				signal,
			);
			return streamHandle;
		}

		// 2. Setup listener BEFORE submitting, guaranteeing completion of setup
		trace?.start("stream.setup");
		const streamHandle = await this.streamListener.setup(
			turnId,
			onToken,
			signal,
			trace,
		);
		trace?.end("stream.setup");
		if (signal?.aborted) {
			await streamHandle.cleanup();
			return null;
		}

		// 3. Submit prompt via hardened DOM automation supporting up to 30k tokens
		const timeoutMs = config.submitTimeoutMs;
		// Escape-safe serialization preserving quotes, backslashes, XML tags, and newlines byte-for-byte
		const serializedPrompt = JSON.stringify(prompt)
			.replace(/\u2028/g, "\\u2028")
			.replace(/\u2029/g, "\\u2029");

		const script = `
            (async function(inputPrompt, timeoutLimitMs) {
                const state = window['__proxyTurn_${turnId}'];
                if (!state || state.aborted) return "ABORTED";

                const tStart = performance.now();
                const editor = document.querySelector('.ql-editor.textarea[contenteditable="true"], .ql-editor[contenteditable="true"], .ql-editor');
                if (!editor) return "EDITOR_NOT_FOUND";

                let inserted = false;

                // Hierarchy Level 1: Model-aware bulk insertion via Quill API
                const quill = editor.parentElement?.__quill || editor.__quill || (window.Quill && window.Quill.find ? window.Quill.find(editor) : null);
                if (quill && typeof quill.setText === 'function') {
                    try {
                        quill.setText(inputPrompt, 'user');
                        inserted = true;
                    } catch (e) {
                        console.warn('Quill bulk insertion failed, attempting fallback:', e);
                    }
                }

                // Hierarchy Level 2: Synthetic clipboard paste
                if (!inserted) {
                    try {
                        editor.focus();
                        document.execCommand('selectAll', false, null);
                        const dt = new DataTransfer();
                        dt.setData('text/plain', inputPrompt);
                        const pasteEvt = new ClipboardEvent('paste', {
                            clipboardData: dt,
                            bubbles: true,
                            cancelable: true,
                            composed: true
                        });
                        editor.dispatchEvent(pasteEvt);
                        if (editor.textContent && editor.textContent.length > 0) {
                            inserted = true;
                        }
                    } catch (e) {
                        console.warn('Synthetic clipboard paste failed, attempting fallback:', e);
                    }
                }

                // Hierarchy Level 3: execCommand('insertText')
                if (!inserted) {
                    try {
                        editor.focus();
                        document.execCommand('selectAll', false, null);
                        inserted = document.execCommand('insertText', false, inputPrompt);
                    } catch (e) {
                        console.warn('execCommand insertText failed, attempting fallback:', e);
                    }
                }

                // Hierarchy Level 4: Last-resort DOM mutation with editor state verification
                if (!inserted || (editor.textContent?.trim().length === 0)) {
                    try {
                        editor.innerHTML = '';
                        const lines = inputPrompt.replace(/\\r\\n|\\r/g, '\\n').split('\\n');
                        for (const line of lines) {
                            const p = document.createElement('p');
                            if (line.length === 0) {
                                p.appendChild(document.createElement('br'));
                            } else {
                                p.textContent = line;
                            }
                            editor.appendChild(p);
                        }
                        inserted = true;
                    } catch (e) {
                        console.warn('DOM mutation fallback failed:', e);
                    }
                }

                // Actively trigger DOM input/change events to wake Angular change detection
                try {
                    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertText', data: inputPrompt }));
                } catch (e) {
                    // Ignore if InputEvent not supported
                }
                editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                editor.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

                // Editor state verification: verify editor contains non-empty content
                const currentContent = (quill && typeof quill.getText === 'function')
                    ? quill.getText().replace(/\\n$/, '')
                    : (editor.innerText || editor.textContent || '').trim();

                if (!currentContent && inputPrompt.length > 0) {
                    return "EDITOR_INSERTION_VERIFICATION_FAILED";
                }

                const tInserted = performance.now();
                // Wait for the send button to become genuinely usable
                return new Promise((resolve) => {
                    let attempts = 0;
                    const intervalMs = 100;
                    const maxAttempts = Math.ceil(timeoutLimitMs / intervalMs);

                    state.submitInterval = setInterval(() => {
                        if (state.aborted) {
                            clearInterval(state.submitInterval);
                            resolve("ABORTED");
                            return;
                        }

                        attempts++;
                        const submitBtn = document.querySelector('button[aria-label="Send message" i], button[aria-label="Send prompt" i], button.send-button-container, .send-button button, [data-test-id="send-button"], button[aria-label*="Send"]');

                        // Strict usability check: exists, visible, not disabled, no aria-disabled
                        const isVisible = submitBtn && (submitBtn.offsetParent !== null || submitBtn.getBoundingClientRect().height > 0);
                        const isEnabled = submitBtn && !submitBtn.disabled && submitBtn.getAttribute('aria-disabled') !== 'true' && !submitBtn.closest('[aria-disabled="true"]');

                        if (isVisible && isEnabled) {
                            const tSubmitReady = performance.now();
                            clearInterval(state.submitInterval);
                            // Final safety check immediately before click
                            if (state.aborted || !window.location.href.includes('gemini.google.com')) {
                                resolve("ABORTED");
                                return;
                            }
                            submitBtn.click();
                            resolve(JSON.stringify({
                                status: "SUCCESS",
                                insertTime: tInserted - tStart,
                                waitTime: tSubmitReady - tInserted,
                                clickTime: performance.now() - tSubmitReady
                            }));
                        } else if (attempts >= maxAttempts) {
                            clearInterval(state.submitInterval);
                            resolve("SUBMIT_BTN_NOT_USABLE_OR_TIMEOUT");
                        }
                    }, intervalMs);
                });
            })(${serializedPrompt}, ${timeoutMs})
        `;

		let submitRes: any;
		try {
			submitRes = await this.cdp.send("Runtime.evaluate", {
				expression: script,
				awaitPromise: true,
				returnByValue: true,
			});
		} catch (e) {
			// CDP connection dropped or evaluation failed fundamentally mid-flight.
			// We must strictly clean up the active StreamListener so it doesn't leak into the next request.
			await streamHandle.cleanup();
			throw e;
		}

		const submitValRaw = submitRes?.result?.value ?? submitRes?.value;
		let submitVal = submitValRaw;

		let browserMetrics: any = null;
		if (typeof submitValRaw === "string" && submitValRaw.startsWith("{")) {
			try {
				const parsed = JSON.parse(submitValRaw);
				submitVal = parsed.status;
				browserMetrics = parsed;
			} catch (e) {
				// Ignore
			}
		}

		if (submitVal === "ABORTED") {
			await streamHandle.cleanup();
			return null;
		}

		if (submitVal !== "SUCCESS") {
			await streamHandle.cleanup();
			throw new Error(`Failed to submit prompt: ${submitVal}`);
		}

		if (browserMetrics && trace) {
			trace.recordDuration("prompt.insertion", browserMetrics.insertTime);
			trace.recordDuration("submit.wait", browserMetrics.waitTime);
			trace.recordDuration("submit.click", browserMetrics.clickTime);
		}

		// 4. Return handle so caller can await completion
		return streamHandle;
	}
}

export const browserWorker = new BrowserWorker();
