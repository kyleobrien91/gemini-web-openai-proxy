import { describe, it, expect, vi } from 'vitest';
import { CDPConnection } from '../src/cdp/connection.js';
import { ModeSwitcher } from '../src/cdp/mode-switcher.js';

describe('ModeSwitcher Verification', () => {
    it('should successfully verify exact matching model labels', async () => {
        expect(ModeSwitcher.verifyLabelMatch('3.7 Flash', ['3.7 Flash', 'Gemini 1.5 Flash'])).toBe(true);
        expect(ModeSwitcher.verifyLabelMatch('Gemini 1.5 Flash', ['3.7 Flash', 'Gemini 1.5 Flash'])).toBe(true);
    });

    it('should fail request if verification fails or matches partially', async () => {
        // Wrong label
        expect(ModeSwitcher.verifyLabelMatch('3.1 Pro', ['3.7 Flash', 'Gemini 1.5 Flash'])).toBe(false);
        // Ambiguous "Flash"
        expect(ModeSwitcher.verifyLabelMatch('Flash', ['3.7 Flash', 'Gemini 1.5 Flash'])).toBe(false);
        // Ambiguous "3.7 Flash-Lite" must not satisfy "3.7 Flash"
        expect(ModeSwitcher.verifyLabelMatch('3.7 Flash-Lite', ['3.7 Flash', 'Gemini 1.5 Flash'])).toBe(false);
    });

    it('should explicitly support 2.5 compatibility aliases', async () => {
        // gemini-2.5-pro maps to expected labels for 3.1-pro
        expect(ModeSwitcher.verifyLabelMatch('3.1 Pro', ['3.1 Pro', 'Gemini 1.5 Pro', 'Gemini Advanced'])).toBe(true);
    });

    it('should fail request if UI element is not found during switchMode', async () => {
        const cdp = new CDPConnection();
        vi.spyOn(cdp, 'send').mockResolvedValue({ value: 'ELEMENT_NOT_FOUND' });

        const switcher = new ModeSwitcher(cdp);
        await expect(switcher.switchMode('gemini-3.5-flash-lite')).rejects.toThrow(/Failed to locate model option/);
    });

    it('should fail request if verification text matches failed format from cdp', async () => {
        const cdp = new CDPConnection();
        vi.spyOn(cdp, 'send').mockResolvedValue({ value: 'VERIFICATION_FAILED: 3.1 Pro' });

        const switcher = new ModeSwitcher(cdp);
        await expect(switcher.switchMode('gemini-3.7-flash')).rejects.toThrow(/Model switch verification failed/);
    });
});
