import { CDPConnection } from './connection.js';
import { getModel, resolveTargetModelId } from '../models/registry.js';

export class ModeSwitcher {
  private cdp: CDPConnection;

  constructor(cdp: CDPConnection) {
    this.cdp = cdp;
  }

  async switchMode(modelName: string): Promise<void> {
    const targetModelId = resolveTargetModelId(modelName);
    if (!targetModelId) {
      throw new Error(`Unknown model: ${modelName}. Supported models are 3.7-flash, 3.1-pro, 3.5-flash-lite, 2.5-pro, 2.5-flash.`);
    }

    const targetModel = getModel(targetModelId);
    if (!targetModel || !targetModel.webDomTestId) {
         throw new Error(`Configuration error: resolved target model ${targetModelId} does not have a webDomTestId.`);
    }

    const testId = targetModel.webDomTestId;

    const script = `
      (async function() {
        const menuBtn = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
        if (!menuBtn) return "MENU_NOT_FOUND";

        menuBtn.click();
        await new Promise(r => setTimeout(r, 500));

        const optionBtn = document.querySelector('[data-test-id="${testId}"]');
        if (!optionBtn) {
            menuBtn.click(); // cleanup
            return "OPTION_NOT_FOUND";
        }

        optionBtn.click();

        // Wait for the UI state to settle
        await new Promise(r => setTimeout(r, 500));

        // Re-open menu to inspect the selected state directly on the exact option element
        menuBtn.click();
        await new Promise(r => setTimeout(r, 500));

        let result = "VERIFICATION_FAILED_NOT_SELECTED";
        try {
            const verifyBtn = document.querySelector('[data-test-id="${testId}"]');
            if (!verifyBtn) {
                result = "VERIFICATION_OPTION_VANISHED";
            } else {
                // Strictly evaluate accessibility and active state classes.
                // We do NOT use broad child queries like 'svg' or 'mat-icon' which can cause false positives.
                const isSelected =
                    verifyBtn.getAttribute('aria-selected') === 'true' ||
                    verifyBtn.getAttribute('aria-checked') === 'true' ||
                    verifyBtn.getAttribute('aria-current') === 'true' ||
                    verifyBtn.classList.contains('selected') ||
                    verifyBtn.classList.contains('is-selected');

                if (isSelected) {
                    result = "SUCCESS";
                }
            }
        } finally {
            // Guarantee menu cleanup on every path
            menuBtn.click();
        }

        return result;
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
