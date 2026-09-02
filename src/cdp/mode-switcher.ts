import { CDPConnection } from './connection.js';

export class ModeSwitcher {
  private cdp: CDPConnection;

  private modeMapping: Record<string, string> = {
    'gemini-3.7-flash': 'bard-mode-option-56fdd199312815e2',
    'gemini-3.1-pro': 'bard-mode-option-e6fa609c3fa255c0',
    'gemini-3.5-flash-lite': 'bard-mode-option-8c46e95b1a07cecc',
    'gemini-2.5-pro': 'bard-mode-option-e6fa609c3fa255c0', // Alias mapping
    'gemini-2.5-flash': 'bard-mode-option-56fdd199312815e2' // Alias mapping
  };

  constructor(cdp: CDPConnection) {
    this.cdp = cdp;
  }

  async switchMode(modelName: string): Promise<void> {
    const testId = this.modeMapping[modelName];
    if (!testId) {
      console.warn(`Unknown model ${modelName}, keeping current mode.`);
      return;
    }

    const script = `
      (async function() {
        const menuBtn = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
        if (menuBtn) {
           menuBtn.click();
           await new Promise(r => setTimeout(r, 500));
           const optionBtn = document.querySelector('[data-test-id="${testId}"]');
           if (optionBtn) {
               optionBtn.click();
           }
        }
      })();
    `;

    try {
      await this.cdp.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
      });
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (e) {
      console.error('Failed to switch model mode via CDP', e);
    }
  }
}
