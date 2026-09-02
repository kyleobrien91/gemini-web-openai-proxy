import { describe, it, expect, vi } from 'vitest';
import { CDPConnection } from '../src/cdp/connection.js';
import { StreamListener } from '../src/cdp/stream-listener.js';

describe('StreamListener Transactional Setup', () => {
    it('should completely roll back registered resources if setup fails midway', async () => {
        const cdp = new CDPConnection();
        // Mock connection state
        (cdp as any).ws = { readyState: 1, send: vi.fn(), on: vi.fn(), close: vi.fn() };

        const offSpy = vi.spyOn(cdp, 'off');
        const offDisconnectSpy = vi.spyOn(cdp, 'offDisconnect');
        const sendSpy = vi.spyOn(cdp, 'send').mockImplementation(async (method: string) => {
             if (method === 'Runtime.addBinding') return; // Pass first few calls
             if (method === 'Runtime.evaluate') {
                 // Throw on the final injection step
                 throw new Error("Simulated injection failure");
             }
        });

        const listener = new StreamListener(cdp);
        const controller = new AbortController();
        const removeListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');

        await expect(listener.setup(vi.fn(), controller.signal)).rejects.toThrow("Simulated injection failure");

        // Assert rollback happened
        expect(offSpy).toHaveBeenCalledWith('Runtime.bindingCalled', expect.any(Function));
        expect(offDisconnectSpy).toHaveBeenCalled();
        expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));

        // Assert cleanup script was sent
        expect(sendSpy).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({
            expression: expect.stringContaining('window.__proxyObserverStarted = false;')
        }));
    });
});
