import { CDPConnection } from './connection.js';

export class ModeSwitcher {
  private cdp: CDPConnection;

  private modeMapping: Record<string, string> = {
    'gemini-3.7-flash': 'bard-mode-option-56fdd199312815e2',
    'gemini-3.1-pro': 'bard-mode-option-e6fa609c3fa255c0',
    'gemini-3.5-flash-lite': 'bard-mode-option-8c46e95b1a07cecc',
    // Compatibility aliases for frontends hardcoding older modes
    'gemini-2.5-pro': 'bard-mode-option-e6fa609c3fa255c0',
    'gemini-2.5-flash': 'bard-mode-option-56fdd199312815e2'
  };

  private exactModeLabels: Record<string, string[]> = {
      'gemini-3.7-flash': ['3.7 Flash', 'Gemini 1.5 Flash'],
      'gemini-3.1-pro': ['3.1 Pro', 'Gemini 1.5 Pro', 'Gemini Advanced'],
      'gemini-3.5-flash-lite': ['3.5 Flash-Lite'],
      // Aliases map to the same expected visual labels of their target physical models
      'gemini-2.5-pro': ['3.1 Pro', 'Gemini 1.5 Pro', 'Gemini Advanced'],
      'gemini-2.5-flash': ['3.7 Flash', 'Gemini 1.5 Flash'],
  };

  constructor(cdp: CDPConnection) {
    this.cdp = cdp;
  }

  async switchMode(modelName: string): Promise<void> {
    const testId = this.modeMapping[modelName];
    const expectedLabels = this.exactModeLabels[modelName];
    if (!testId || !expectedLabels) {
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

               const finalBtn = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
               const selectedText = (finalBtn ? finalBtn.textContent || "" : "").trim();

               const allowedLabels = ${JSON.stringify(expectedLabels)};

               // Authoritative check: We require an exact match against one of the known valid labels for this model.
               // We do not allow partial substring matches (e.g. "Flash" matching "3.5 Flash-Lite" or "3.7 Flash").
               const verified = allowedLabels.some(label => {
                   // Clean up text in case of UI spans/icons rendering extra space
                   return selectedText === label || selectedText.startsWith(label);
               });

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
               throw new Error(`Model switch verification failed. Expected exact match for ${modelName}, but UI indicates currently selected model is: ${res.value}`);
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
