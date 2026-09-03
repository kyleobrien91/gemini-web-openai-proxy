import { CDPConnection } from './connection.js';

export class ModeSwitcher {
  private cdp: CDPConnection;

  private modeMapping: Record<string, string> = {
    'gemini-3.7-flash': 'bard-mode-option-56fdd199312815e2',
    'gemini-3.1-pro': 'bard-mode-option-e6fa609c3fa255c0',
    'gemini-3.5-flash-lite': 'bard-mode-option-cf41b0e0dd7d53e5', // Updated from 8c46e95b1a07cecc (3.1 Flash-Lite)

    // BACKWARDS COMPATIBILITY ALIASES:
    // Clients using generic older names like 2.5-pro or 2.5-flash will be mapped to the UI components
    // for 3.1-pro and 3.7-flash respectively, because Google Web UI no longer reliably serves "2.5" labelled options.
    // This allows seamless backward compatibility for older agents, but note that the actual underlying model
    // servicing the request will be the newer 3.x series model selected in the UI.
    'gemini-2.5-pro': 'bard-mode-option-e6fa609c3fa255c0',
    'gemini-2.5-flash': 'bard-mode-option-56fdd199312815e2'
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
        if (!menuBtn) return "MENU_NOT_FOUND";

        menuBtn.click();
        await new Promise(r => setTimeout(r, 500));

        const optionBtn = document.querySelector('[data-test-id="${testId}"]');
        if (!optionBtn) return "OPTION_NOT_FOUND";

        optionBtn.click();

        // Wait for the UI state to settle
        await new Promise(r => setTimeout(r, 500));

        // Re-open menu to inspect the selected state directly on the exact option element
        menuBtn.click();
        await new Promise(r => setTimeout(r, 500));

        const verifyBtn = document.querySelector('[data-test-id="${testId}"]');
        if (!verifyBtn) return "VERIFICATION_OPTION_VANISHED";

        const isSelected = verifyBtn.getAttribute('aria-selected') === 'true' || verifyBtn.getAttribute('aria-checked') === 'true';

        // Close menu again
        menuBtn.click();

        if (isSelected) {
            return "SUCCESS";
        }

        return "VERIFICATION_FAILED_NOT_SELECTED";
      })();
    `;

    try {
      const res = await this.cdp.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true
      });

      if (res && res.value) {
          if (res.value === "MENU_NOT_FOUND" || res.value === "OPTION_NOT_FOUND") {
               throw new Error(`Failed to locate model option for ${modelName} in the UI. Ensure your account has access to this model.`);
          }
          if (res.value !== "SUCCESS") {
               throw new Error(`Model switch verification failed. Expected exact DOM state match for ${modelName} (${testId}), but UI indicates it is not selected. Debug state: ${res.value}`);
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
