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

  private modeNameMapping: Record<string, string[]> = {
      'gemini-3.7-flash': ['3.7 flash', 'gemini 1.5 flash', 'flash'], // Fallbacks depending on ui a/b testing
      'gemini-3.1-pro': ['3.1 pro', 'gemini 1.5 pro', 'gemini advanced'],
      'gemini-3.5-flash-lite': ['3.5 flash-lite', 'flash-lite'],
      'gemini-2.5-pro': ['3.1 pro', 'gemini 1.5 pro', 'gemini advanced'],
      'gemini-2.5-flash': ['3.7 flash', 'gemini 1.5 flash', 'flash'],
  };

  constructor(cdp: CDPConnection) {
    this.cdp = cdp;
  }

  async switchMode(modelName: string): Promise<void> {
    const testId = this.modeMapping[modelName];
    const expectedKeywords = this.modeNameMapping[modelName];
    if (!testId || !expectedKeywords) {
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
               // Wait for the UI state to settle
               await new Promise(r => setTimeout(r, 500));

               // Verification logic: We read the text content of the menu button which indicates the currently selected model
               const finalBtn = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
               const selectedText = (finalBtn ? finalBtn.textContent || "" : "").toLowerCase();

               const keywords = ${JSON.stringify(expectedKeywords)};
               // Allow partial match on expected keywords
               const verified = keywords.some(k => selectedText.includes(k));

               if (verified) return "SUCCESS";
               return "VERIFICATION_FAILED: " + selectedText;
           }
        }
        return "ELEMENT_NOT_FOUND";
      })();
    `;

    try {
      const res = await this.cdp.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true
      });

      if (res && res.value) {
          if (res.value === "ELEMENT_NOT_FOUND") {
               throw new Error(`Failed to locate model option for ${modelName} in the UI. Ensure your account has access to this model.`);
          }
          if (res.value.startsWith("VERIFICATION_FAILED")) {
               throw new Error(`Model switch verification failed. Expected to switch to ${modelName}, but UI indicates currently selected model is: ${res.value}`);
          }
          // Success!
      } else {
          throw new Error(`Unexpected failure executing mode switch script.`);
      }

    } catch (e) {
      console.error('Failed to switch model mode via CDP', e);
      throw new Error(`Model switch failed for ${modelName}: ${(e as Error).message}`);
    }
  }
}
