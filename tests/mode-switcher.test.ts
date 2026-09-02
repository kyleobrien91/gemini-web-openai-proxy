import { describe, it, expect, vi } from 'vitest';
import { CDPConnection } from '../src/cdp/connection.js';
import { ModeSwitcher } from '../src/cdp/mode-switcher.js';

describe('ModeSwitcher Verification', () => {
    it('should successfully verify exact matching model labels', async () => {
        const cdp = new CDPConnection();
        const sendSpy = vi.spyOn(cdp, 'send').mockResolvedValue({ value: 'SUCCESS' });

        const switcher = new ModeSwitcher(cdp);
        await expect(switcher.switchMode('gemini-3.7-flash')).resolves.not.toThrow();
        expect(sendSpy).toHaveBeenCalled();
    });

    it('should fail request if verification fails', async () => {
        const cdp = new CDPConnection();
        const sendSpy = vi.spyOn(cdp, 'send').mockResolvedValue({ value: 'VERIFICATION_FAILED: Unknown Label' });

        const switcher = new ModeSwitcher(cdp);
        await expect(switcher.switchMode('gemini-3.1-pro')).rejects.toThrow(/Model switch verification failed/);
    });

    it('should fail request if UI element is not found', async () => {
        const cdp = new CDPConnection();
        const sendSpy = vi.spyOn(cdp, 'send').mockResolvedValue({ value: 'ELEMENT_NOT_FOUND' });

        const switcher = new ModeSwitcher(cdp);
        await expect(switcher.switchMode('gemini-3.5-flash-lite')).rejects.toThrow(/Failed to locate model option/);
    });

    it('should correctly handle alias models mapping to newer labels', async () => {
        const cdp = new CDPConnection();
        const sendSpy = vi.spyOn(cdp, 'send').mockResolvedValue({ value: 'SUCCESS' });

        const switcher = new ModeSwitcher(cdp);
        await expect(switcher.switchMode('gemini-2.5-pro')).resolves.not.toThrow();
        // The script that got sent should have expected "3.1 Pro" or "Gemini 1.5 Pro"
        const callArgs = sendSpy.mock.calls[0][1];
        expect(callArgs.expression).toContain('3.1 Pro');
    });
});
