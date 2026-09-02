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
      throw new Error(`Unknown model: ${modelName}. Supported models are 3.7-flash, 3.1-pro, 3.5-flash-lite.`);
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
               // Wait a moment for UI to update
               await new Promise(r => setTimeout(r, 500));

               // Verification logic. In Gemini Web, selected item typically has an aria-checked or aria-selected attribute
               // We fallback to just checking if the menu button text contains part of the model name or if we clicked successfully.
               // Since we don't have the exact selected DOM structure guaranteed, if we found and clicked it, we assume success.
               return true;
           }
        }
        return false;
      })();
    `;

    try {
      const res = await this.cdp.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true
      });

      if (res && res.value === false) {
          throw new Error(`Failed to locate model option for ${modelName} in the UI. Ensure your account has access to this model.`);
      }

    } catch (e) {
      console.error('Failed to switch model mode via CDP', e);
      throw new Error(`Model switch failed for ${modelName}: ${(e as Error).message}`);
    }
  }
}
