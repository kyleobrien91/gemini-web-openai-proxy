import { describe, it, expect, vi } from 'vitest';
import { CDPConnection } from '../src/cdp/connection.js';
import { StreamListener } from '../src/cdp/stream-listener.js';

describe('StreamListener Transactional Setup', () => {
    it('should completely roll back registered resources if setup fails midway', async () => {
        const cdp = new CDPConnection();
        // Mock connection state
        (cdp as any).ws = { readyState: 1, send: vi.fn(), on: vi.fn(), close: vi.fn() };

        let bindingsCount = 0;
        const sendSpy = vi.spyOn(cdp, 'send').mockImplementation(async (method: string) => {
             if (method === 'Runtime.addBinding') {
                 bindingsCount++;
                 return; // Allow bindings to succeed
             }
             if (method === 'Runtime.evaluate') {
                 // Throw on the final script evaluation step
                 throw new Error("Simulated injection failure");
             }
             return;
        });

        const offSpy = vi.spyOn(cdp, 'off');
        const offDisconnectSpy = vi.spyOn(cdp, 'offDisconnect');

        const listener = new StreamListener(cdp);
        const controller = new AbortController();
        const removeListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');

        await expect(listener.setup(vi.fn(), controller.signal)).rejects.toThrow("Simulated injection failure");

        // Assert bindings were actually called before failure
        expect(bindingsCount).toBeGreaterThan(0);

        // Assert rollback cleanup occurred
        expect(offSpy).toHaveBeenCalledWith('Runtime.bindingCalled', expect.any(Function));
        expect(offDisconnectSpy).toHaveBeenCalledWith(expect.any(Function));
        expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));

        // Assert cleanup JS script was evaluated as part of rollback
        expect(sendSpy).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({
            expression: expect.stringContaining('window.__proxyObserverStarted = false;')
        }));
    });
});
