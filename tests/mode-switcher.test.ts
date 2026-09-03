import { describe, it, expect, vi } from 'vitest';
import { CDPConnection } from '../src/cdp/connection.js';
import { ModeSwitcher } from '../src/cdp/mode-switcher.js';

describe('ModeSwitcher Verification Logic', () => {

    describe('CDP execution and failure handling', () => {
        it('should successfully complete if target UI element reports SUCCESS', async () => {
            const cdp = new CDPConnection();
            vi.spyOn(cdp, 'send').mockResolvedValue({ value: 'SUCCESS' });

            const switcher = new ModeSwitcher(cdp);
            await expect(switcher.switchMode('gemini-3.7-flash')).resolves.not.toThrow();
        });

        it('should fail request if UI element is not found during switchMode', async () => {
            const cdp = new CDPConnection();
            vi.spyOn(cdp, 'send').mockResolvedValue({ value: 'OPTION_NOT_FOUND' });

            const switcher = new ModeSwitcher(cdp);
            await expect(switcher.switchMode('gemini-3.5-flash-lite')).rejects.toThrow(/Failed to locate model option/);
        });

        it('should fail request if verification state check returns unselected', async () => {
            const cdp = new CDPConnection();
            vi.spyOn(cdp, 'send').mockResolvedValue({ value: 'VERIFICATION_FAILED_NOT_SELECTED' });

            const switcher = new ModeSwitcher(cdp);
            await expect(switcher.switchMode('gemini-3.7-flash')).rejects.toThrow(/Model switch verification failed/);
        });

        it('should explicitly support 2.5 compatibility aliases mapping to 3.x UI targets', async () => {
            const cdp = new CDPConnection();
            const sendSpy = vi.spyOn(cdp, 'send').mockResolvedValue({ value: 'SUCCESS' });

            const switcher = new ModeSwitcher(cdp);
            await expect(switcher.switchMode('gemini-2.5-pro')).resolves.not.toThrow();

            // Should map to the exact test-id of 3.1 Pro (bard-mode-option-e6fa609c3fa255c0)
            const callArgs = sendSpy.mock.calls[0][1];
            expect(callArgs.expression).toContain('bard-mode-option-e6fa609c3fa255c0');
        });
    });
});
