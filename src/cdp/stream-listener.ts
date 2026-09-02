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

      const script = `
        (function() {
            if (window.__proxyObserverStarted) return;
            window.__proxyObserverStarted = true;

            let lastText = "";
            window.__proxyObserver = new MutationObserver(() => {
                const elements = document.querySelectorAll('.model-response-text, model-response, .response-container-content, message-content');
                if (elements.length > 0) {
                    const latest = elements[elements.length - 1];
                    const currentText = latest.innerText || latest.textContent || "";
                    if (currentText.length > lastText.length) {
                        const diff = currentText.substring(lastText.length);
                        lastText = currentText;
                        window.proxyEmitToken(diff);
                    }
                }
            });
            window.__proxyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

            window.__proxyCheckDone = setInterval(() => {
                const sendBtn = document.querySelector('button[aria-label="Send prompt"], button.send-button-container');
                if (sendBtn && !sendBtn.disabled && lastText.length > 0) {
                    clearInterval(window.__proxyCheckDone);
                    window.__proxyObserver.disconnect();
                    window.__proxyObserverStarted = false;
                    window.proxyEmitComplete("done");
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
