import { describe, it, expect, vi } from 'vitest';
import { CDPConnection } from '../src/cdp/connection.js';
import { ModeSwitcher } from '../src/cdp/mode-switcher.js';

describe('ModeSwitcher Verification Logic', () => {

    // Core logic verification tests as requested
    describe('verifyLabelMatch core logic', () => {
        const flashLabels = ['3.7 Flash', 'Gemini 1.5 Flash'];

        it('matches exactly expected labels', () => {
            expect(ModeSwitcher.verifyLabelMatch('3.7 Flash', flashLabels)).toBe(true);
            expect(ModeSwitcher.verifyLabelMatch('Gemini 1.5 Flash', flashLabels)).toBe(true);
        });

        it('rejects permissive substrings and prefixes', () => {
            expect(ModeSwitcher.verifyLabelMatch('Flash', flashLabels)).toBe(false);
            expect(ModeSwitcher.verifyLabelMatch('3.7 Flash-Lite', flashLabels)).toBe(false);
            expect(ModeSwitcher.verifyLabelMatch('3.7 Pro', flashLabels)).toBe(false);
            expect(ModeSwitcher.verifyLabelMatch('Gemini 1.5 Flash with extra text', flashLabels)).toBe(false);
        });

        it('rejects empty or whitespace text', () => {
            expect(ModeSwitcher.verifyLabelMatch('', flashLabels)).toBe(false);
            expect(ModeSwitcher.verifyLabelMatch('   ', flashLabels)).toBe(false);
        });

        it('validates alias mappings to exact target UI labels', () => {
            const proLabels = ['3.1 Pro', 'Gemini 1.5 Pro', 'Gemini Advanced'];
            // 2.5-pro maps to 3.1-pro labels
            expect(ModeSwitcher.verifyLabelMatch('3.1 Pro', proLabels)).toBe(true);
            expect(ModeSwitcher.verifyLabelMatch('2.5 Pro', proLabels)).toBe(false); // Because the UI won't show 2.5 Pro
        });
    });

    describe('CDP execution and failure handling', () => {
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
});
