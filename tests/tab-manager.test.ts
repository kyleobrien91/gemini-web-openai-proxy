import { describe, it, expect, vi } from 'vitest';
import { CDPConnection } from '../src/cdp/connection.js';
import { TabManager } from '../src/cdp/tab-manager.js';

describe('TabManager Navigation Correlation', () => {
    it('should ignore uncorrelated load events', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout']
        });

        const cdp = new CDPConnection();
        // Mock connection state
        (cdp as any).ws = { readyState: 1, send: vi.fn(), on: vi.fn(), close: vi.fn() };
        (cdp as any).targetId = "target123";

        let lifecycleHandler: any;
        const onSpy = vi.spyOn(cdp, 'on').mockImplementation((event, handler) => {
            if (event === 'Page.lifecycleEvent') {
                lifecycleHandler = handler;
            }
        });

        const sendSpy = vi.spyOn(cdp, 'send').mockImplementation(async (method) => {
            if (method === 'Page.navigate') {
                return { loaderId: 'loader1', frameId: 'frame1' };
            }
            if (method === 'Runtime.evaluate') {
                return { value: 'SUCCESS' }; // Mock the "New chat" script execution
            }
            return {};
        });

        const tabManager = new TabManager(cdp);

        // Start reset, do not await yet because we need to trigger events
        const resetPromise = tabManager.resetChatSession();

        // Let event loop settle so send is called
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Trigger uncorrelated event
        lifecycleHandler({ name: 'load', loaderId: 'loader99', frameId: 'frame99' });

        // Advance timer a bit, but not enough to timeout
        vi.advanceTimersByTime(1000);

        // Promise should still be pending
        let resolved = false;
        resetPromise.then(() => resolved = true).catch(() => {});
        await Promise.resolve();
        expect(resolved).toBe(false);

        // Trigger correlated event
        lifecycleHandler({ name: 'load', loaderId: 'loader1', frameId: 'frame1' });

        // Let the promise resolve, then advance the SPA wait timers
        await Promise.resolve();
        vi.runAllTimers();

        await resetPromise; // Should resolve successfully now
        expect(resolved).toBe(true);

        vi.useRealTimers();
    });
});
