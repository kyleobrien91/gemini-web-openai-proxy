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
        let menuBtn = null;
        for (let i = 0; i < 150; i++) {
            const editor = document.querySelector('.ql-editor');
            if (editor && i % 5 === 0) {
                editor.focus();
                editor.dispatchEvent(new Event('focus', { bubbles: true }));
            }
            menuBtn = document.querySelector('button[data-test-id="bard-mode-menu-button"], button[aria-label*="mode picker"], .input-area-switch');
            if (menuBtn) break;
            await new Promise(r => setTimeout(r, 100));
        }

        if (!menuBtn) return "MENU_NOT_FOUND";

        const currentLabel = (menuBtn.getAttribute('aria-label') || '').toLowerCase();
        const currentText = (menuBtn.textContent || '').toLowerCase();
        const combinedIndicator = currentLabel + ' ' + currentText;

        let alreadySelected = false;
        if ('${targetModelId}' === 'gemini-3.5-flash-lite') {
            alreadySelected = combinedIndicator.includes('lite');
        } else if ('${targetModelId}' === 'gemini-3.7-flash') {
            alreadySelected = combinedIndicator.includes('flash') && !combinedIndicator.includes('lite');
        } else if ('${targetModelId}' === 'gemini-3.1-pro') {
            alreadySelected = combinedIndicator.includes('pro');
        }

        if (alreadySelected) {
            return "SUCCESS";
        }

        const triggerPointerClick = (el) => {
            el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }));
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
            el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
            el.click();
        };

        triggerPointerClick(menuBtn);

        let optionBtn = null;
        for (let i = 0; i < 20; i++) {
            optionBtn = document.querySelector('[data-test-id="${testId}"]');
            if (!optionBtn && '${targetModelId}' === 'gemini-3.5-flash-lite') {
                optionBtn = document.querySelector('[data-test-id="bard-mode-option-8c46e95b1a07cecc"], [data-test-id="bard-mode-option-cf41b0e0dd7d53e5"]');
            }
            if (optionBtn) break;
            await new Promise(r => setTimeout(r, 100));
        }

        if (!optionBtn) {
            triggerPointerClick(menuBtn); // cleanup
            return "OPTION_NOT_FOUND";
        }

        triggerPointerClick(optionBtn);

        // Verify button indicator reflects the target model
        for (let i = 0; i < 25; i++) {
            const updatedLabel = (menuBtn.getAttribute('aria-label') || '').toLowerCase();
            const updatedText = (menuBtn.textContent || '').toLowerCase();
            const updatedCombined = updatedLabel + ' ' + updatedText;

            let verified = false;
            if ('${targetModelId}' === 'gemini-3.5-flash-lite') {
                verified = updatedCombined.includes('lite');
            } else if ('${targetModelId}' === 'gemini-3.7-flash') {
                verified = updatedCombined.includes('flash') && !updatedCombined.includes('lite');
            } else if ('${targetModelId}' === 'gemini-3.1-pro') {
                verified = updatedCombined.includes('pro');
            }

            if (verified) {
                return "SUCCESS";
            }
            await new Promise(r => setTimeout(r, 100));
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

      const val = res?.result?.value ?? res?.value;
      if (res && val) {
          if (val === "MENU_NOT_FOUND") {
               throw new Error(`Model mode picker menu button not found in the Gemini UI.`);
          }
          if (val === "OPTION_NOT_FOUND") {
               throw new Error(`Failed to locate model option for ${modelName} in the UI. Ensure your account has access to this model.`);
          }
          if (val !== "SUCCESS") {
               throw new Error(`Model switch verification failed. Expected exact DOM state match for ${modelName} (${testId}), but UI indicates it is not selected. Debug state: ${val}`);
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
