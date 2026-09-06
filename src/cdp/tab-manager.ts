import type { CDPConnection } from "./connection.js";

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
		// Check if we are already on a fresh chat page (menuBtn and editor mounted, no chat history).
		// If so, clicking "New chat" or doing nothing is virtually instantaneous and avoids a 10s page reload.
		const quickCheck = await this.cdp.send("Runtime.evaluate", {
			expression: `(() => {
				const existingResponses = document.querySelectorAll('.model-response-text, model-response');
				const menuBtn = document.querySelector('button[data-test-id="bard-mode-menu-button"], button.input-area-switch, button[aria-label*="mode picker"], button[aria-label*="Mode picker"]');
				const inputArea = document.querySelector('.ql-editor, [contenteditable="true"], textarea');
				const isAppUrl = window.location.href.includes('gemini.google.com/app');
				return {
					isFresh: isAppUrl && existingResponses.length === 0 && Boolean(menuBtn) && Boolean(inputArea),
					hasResponses: existingResponses.length > 0,
					isAppUrl
				};
			})()`,
			returnByValue: true,
		});

		const quickVal = quickCheck?.value ?? quickCheck?.result?.value;
		if (quickVal?.isFresh) {
			return; // Already on a clean, ready-to-use conversation!
		}

		// If on /app and just has old messages, click "New chat" without a hard reload
		if (quickVal?.isAppUrl && quickVal?.hasResponses) {
			const clickRes = await this.cdp.send("Runtime.evaluate", {
				expression: `(async function() {
					const allCandidates = Array.from(document.querySelectorAll('a, button'));
					const newChatBtn = allCandidates.find(el =>
						(el.getAttribute('href') === '/app' && (el.innerText || '').includes('New chat')) ||
						((el.getAttribute('aria-label') || '') === 'New chat' && el.getAttribute('href') === '/app')
					) || document.querySelector('a[href="/app"], [data-test-id*="new-chat"]');

					if (newChatBtn) {
						newChatBtn.click();
						const start = Date.now();
						while (Date.now() - start < 5000) {
							const menuBtn = document.querySelector('button[data-test-id="bard-mode-menu-button"], button.input-area-switch, button[aria-label*="mode picker"], button[aria-label*="Mode picker"]');
							const remaining = document.querySelectorAll('.model-response-text, model-response');
							if (menuBtn && remaining.length === 0) return "SUCCESS";
							await new Promise(r => setTimeout(r, 200));
						}
					}
					return "NEEDS_FULL_NAV";
				})()`,
				awaitPromise: true,
				returnByValue: true,
			});
			const clickVal = clickRes?.value ?? clickRes?.result?.value;
			if (clickVal === "SUCCESS") {
				return;
			}
		}

		// Fallback: Full navigation to https://gemini.google.com/app
		await this.cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });

		await new Promise<void>(async (resolve, _reject) => {
			let timeoutId: NodeJS.Timeout;
			let expectedLoaderId: string | null = null;
			let expectedFrameId: string | null = null;
			let hasNavigated = false;
			const pendingEvents: any[] = [];

			const cleanup = () => {
				clearTimeout(timeoutId);
				this.cdp.off("Page.lifecycleEvent", lifecycleHandler);
			};

			const processLifecycleEvent = (event: any) => {
				if (expectedLoaderId && event.loaderId !== expectedLoaderId) return;
				if (expectedFrameId && event.frameId !== expectedFrameId) return;
				if (event.name === "load") {
					cleanup();
					resolve();
				}
			};

			const lifecycleHandler = (event: any) => {
				if (!hasNavigated) {
					pendingEvents.push(event);
					return;
				}
				processLifecycleEvent(event);
			};

			this.cdp.on("Page.lifecycleEvent", lifecycleHandler);

			timeoutId = setTimeout(() => {
				cleanup();
				resolve(); // Don't reject on load timeout if page is already responsive
			}, 8000);

			try {
				const res = await this.cdp.send("Page.navigate", {
					url: "https://gemini.google.com/app",
				});
				if (!res.loaderId) {
					cleanup();
					return resolve();
				}
				expectedLoaderId = res.loaderId;
				expectedFrameId = res.frameId;
				hasNavigated = true;
				for (const event of pendingEvents) {
					processLifecycleEvent(event);
				}
			} catch (_e) {
				cleanup();
				return resolve(); // proceed to verification
			}
		});

		// Wait up to 25 seconds for UI to settle and mount elements
		const verifyRes = await this.cdp.send("Runtime.evaluate", {
			expression: `(async function() {
				const start = Date.now();
				while (Date.now() - start < 25000) {
					const menuBtn = document.querySelector('button[data-test-id="bard-mode-menu-button"], button.input-area-switch, button[aria-label*="mode picker"], button[aria-label*="Mode picker"]');
					const inputArea = document.querySelector('.ql-editor, [contenteditable="true"], textarea');
					const responses = document.querySelectorAll('.model-response-text, model-response');
					if (menuBtn && inputArea && responses.length === 0) {
						return "SUCCESS";
					}
					await new Promise(r => setTimeout(r, 300));
				}
				return "SETTLE_TIMEOUT";
			})()`,
			awaitPromise: true,
			returnByValue: true,
		});

		const verifyVal = verifyRes?.value ?? verifyRes?.result?.value;
		if (verifyVal !== "SUCCESS") {
			throw new Error(`Failed to reset chat session in Gemini UI: ${verifyVal}`);
		}
	}
}
