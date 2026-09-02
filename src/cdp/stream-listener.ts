import { CDPConnection } from './connection.js';

export class StreamListener {
  private cdp: CDPConnection;

  constructor(cdp: CDPConnection) {
    this.cdp = cdp;
  }

  async listen(onToken: (token: string) => void): Promise<void> {
    await this.cdp.send('Runtime.addBinding', { name: 'proxyEmitToken' });
    await this.cdp.send('Runtime.addBinding', { name: 'proxyEmitComplete' });

    let bindingHandler: (event: any) => void;

    return new Promise((resolve) => {
      bindingHandler = (event: any) => {
        if (event.name === 'proxyEmitToken') {
          onToken(event.payload);
        } else if (event.name === 'proxyEmitComplete') {
          this.cdp.off('Runtime.bindingCalled', bindingHandler);
          resolve();
        }
      };
      this.cdp.on('Runtime.bindingCalled', bindingHandler);

      const script = `
        (function() {
            if (window.__proxyObserverStarted) return;
            window.__proxyObserverStarted = true;

            let lastText = "";
            const observer = new MutationObserver(() => {
                const elements = document.querySelectorAll('message-content');
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
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });

            const checkDone = setInterval(() => {
                const sendBtn = document.querySelector('button[aria-label="Send prompt"]');
                if (sendBtn && !sendBtn.disabled && lastText.length > 0) {
                    clearInterval(checkDone);
                    observer.disconnect();
                    window.__proxyObserverStarted = false;
                    window.proxyEmitComplete("done");
                }
            }, 500);
        })();
      `;
      this.cdp.send('Runtime.evaluate', { expression: script }).catch(console.error);
    });
  }
}
