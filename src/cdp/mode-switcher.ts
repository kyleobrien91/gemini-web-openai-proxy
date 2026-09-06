import { CDPConnection } from './connection.js';
import { getModel, resolveTargetModel, modelRegistry } from '../models/registry.js';

export class ModeSwitcher {
  private cdp: CDPConnection;

  constructor(cdp: CDPConnection) {
    this.cdp = cdp;
  }

  async switchMode(modelName: string): Promise<void> {
    const targetModel = resolveTargetModel(modelName);
    if (!targetModel) {
      throw new Error(`Unknown model: ${modelName}. Supported models are: ${Object.keys(modelRegistry).join(', ')}.`);
    }

    if (targetModel.id === 'default') {
      return; // Keep current UI selection
    }

    const testId = targetModel.webDomTestId || '';
    const targetModelId = targetModel.id;
    const targetExtendedThinking = targetModel.extendedThinking;

    const script = `
      (async function() {
        function findMenuButton() {
          return document.querySelector('button[data-test-id="bard-mode-menu-button"], button.input-area-switch, button[aria-label*="mode picker"], button[aria-label*="Mode picker"]');
        }
        let menuBtn = findMenuButton();
        if (!menuBtn) {
          const start = Date.now();
          while (Date.now() - start < 8000) {
            menuBtn = findMenuButton();
            if (menuBtn) break;
            await new Promise(r => setTimeout(r, 200));
          }
        }
        if (!menuBtn) return "MENU_NOT_FOUND";

        const currentText = menuBtn.innerText.toLowerCase();
        const currentAria = (menuBtn.getAttribute('aria-label') || '').toLowerCase();
        const currentHasExtended = currentText.includes('extended') || currentAria.includes('extended');

        let currentBaseModel = 'unknown';
        if (currentText.includes('lite') || currentAria.includes('lite')) currentBaseModel = 'gemini-flash-lite';
        else if (currentText.includes('flash') || currentAria.includes('flash')) currentBaseModel = 'gemini-flash';
        else if (currentText.includes('pro') || currentAria.includes('pro')) currentBaseModel = 'gemini-pro';

        const target = ${JSON.stringify(targetModelId)};
        let targetBaseModel = target;
        if (target.includes('flash-lite')) targetBaseModel = 'gemini-flash-lite';
        else if (target.includes('flash')) targetBaseModel = 'gemini-flash';
        else if (target.includes('pro')) targetBaseModel = 'gemini-pro';

        const desiredExtended = ${JSON.stringify(targetExtendedThinking)};

        const modelMatches = (currentBaseModel === targetBaseModel);
        const extendedMatches = (desiredExtended === undefined || currentHasExtended === desiredExtended);

        if (modelMatches && extendedMatches) {
          return "SUCCESS";
        }

        // Open menu
        menuBtn.click();
        const openStart = Date.now();
        while (Date.now() - openStart < 3000) {
          if (document.querySelector('gem-menu-item')) break;
          await new Promise(r => setTimeout(r, 100));
        }

        function getItems() {
          return Array.from(document.querySelectorAll('gem-menu-item, [role="menuitem"], [role="option"], button, a, [data-test-id*="bard-mode"]'));
        }

        // 1. Switch base model if needed
        if (!modelMatches) {
          function findModelOption() {
            if (${JSON.stringify(testId)}) {
              const byTestId = document.querySelector('[data-test-id="${testId}"]');
              if (byTestId) return byTestId;
            }

            const items = getItems();
            for (const item of items) {
              const text = (item.textContent || '').trim().toLowerCase();
              const ariaLabel = (item.getAttribute('aria-label') || '').toLowerCase();
              const combined = text + ' ' + ariaLabel;

              if (targetBaseModel === 'gemini-flash-lite') {
                if (combined.includes('flash lite') || combined.includes('flash-lite') || combined.includes('lite')) return item;
              } else if (targetBaseModel === 'gemini-flash') {
                if (combined.includes('flash') && !combined.includes('lite')) return item;
              } else if (targetBaseModel === 'gemini-pro') {
                if (combined.includes('pro') || combined.includes('advanced')) return item;
              }
            }
            return null;
          }

          const modelOption = findModelOption();
          if (!modelOption) {
            menuBtn.click();
            return "OPTION_NOT_FOUND";
          }

          modelOption.click();
          await new Promise(r => setTimeout(r, 600));

          // Ensure menu is open for checking extended thinking
          const isOpen = Boolean(document.querySelector('gem-menu-item'));
          if (!isOpen) {
            menuBtn.click();
            await new Promise(r => setTimeout(r, 500));
          }
        }

        // 2. Adjust Extended Thinking if specified
        if (desiredExtended !== undefined) {
          const itemsNow = getItems();
          const thinkingItem = itemsNow.find(el => el.innerText && el.innerText.includes('Extended thinking'));

          if (thinkingItem) {
            const isThinkingActive = thinkingItem.classList.contains('selected') || 
                                     Boolean(thinkingItem.querySelector('mat-icon[data-mat-icon-name="check"], gem-icon[aria-label="Selected"]'));

            if (isThinkingActive !== desiredExtended) {
              thinkingItem.click();
              await new Promise(r => setTimeout(r, 600));
            }
          }
        }

        // Ensure menu is closed
        const menuStillOpen = Boolean(document.querySelector('gem-menu-item'));
        if (menuStillOpen) {
          menuBtn.click();
          await new Promise(r => setTimeout(r, 400));
        }

        return "SUCCESS";
      })();
    `;

    try {
      const res = await this.cdp.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true
      });

      const resValue = res?.value ?? res?.result?.value;
      if (resValue) {
          if (resValue === "MENU_NOT_FOUND" || resValue === "OPTION_NOT_FOUND") {
               throw new Error(`Failed to locate model option for ${modelName} in the UI (${resValue}). Ensure your account has access to this model.`);
          }
          if (resValue !== "SUCCESS") {
               throw new Error(`Model switch failed for ${modelName}. Debug state: ${resValue}`);
          }
          // Success!
      } else {
          throw new Error(`Unexpected failure executing mode switch script.`);
      }

    } catch (e) {
      console.error('Failed to switch model mode via CDP', e);
      throw e;
    }
  }
}

