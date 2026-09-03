import { describe, it, expect, vi } from 'vitest';
import { CDPConnection } from '../src/cdp/connection.js';
import { StreamListener } from '../src/cdp/stream-listener.js';

describe('StreamListener Transactional Setup', () => {
    it('should completely roll back registered resources if setup fails midway', async () => {
        const cdp = new CDPConnection();
        // Mock connection state
        (cdp as any).ws = { readyState: 1, send: vi.fn(), on: vi.fn(), close: vi.fn() };

        let bindingsCount = 0;
        const sendSpy = vi.spyOn(cdp, 'send').mockImplementation(async (method: string, params: any) => {
             if (method === 'Runtime.addBinding') {
                 bindingsCount++;
                 return; // Allow bindings to succeed
             }
             if (method === 'Runtime.evaluate') {
                 // Throw on the initial observer injection step
                 if (params && params.expression && params.expression.includes('READY')) {
                     throw new Error("Simulated injection failure");
                 }
             }
             return;
        });

        const offSpy = vi.spyOn(cdp, 'off');
        const offDisconnectSpy = vi.spyOn(cdp, 'offDisconnect');

        const listener = new StreamListener(cdp);
        const controller = new AbortController();
        const removeListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');

        await expect(listener.setup('test-turn-id', vi.fn(), controller.signal)).rejects.toThrow("Simulated injection failure");

        // Assert bindings were actually called before failure
        expect(bindingsCount).toBeGreaterThan(0);

        // Assert rollback cleanup occurred
        expect(offSpy).toHaveBeenCalledWith('Runtime.bindingCalled', expect.any(Function));
        expect(offDisconnectSpy).toHaveBeenCalledWith(expect.any(Function));
        expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));

        // Assert cleanup JS script was evaluated as part of rollback (which is now the last call)
        const allCalls = sendSpy.mock.calls;
        const cleanupCall = allCalls.find(call => call[0] === 'Runtime.evaluate' && call[1]?.expression?.includes('__proxyTurn_test-turn-id') && !call[1]?.expression?.includes('READY'));
        expect(cleanupCall).toBeDefined();
    });

    it('should propagate unrelated Runtime.addBinding errors', async () => {
        const cdp = new CDPConnection();
        (cdp as any).ws = { readyState: 1, send: vi.fn(), on: vi.fn(), close: vi.fn() };

        vi.spyOn(cdp, 'send').mockImplementation(async (method: string) => {
             if (method === 'Runtime.addBinding') {
                 throw new Error("Target closed");
             }
             return;
        });

        const listener = new StreamListener(cdp);
        await expect(listener.setup('test', vi.fn())).rejects.toThrow("Target closed");
    });
});
