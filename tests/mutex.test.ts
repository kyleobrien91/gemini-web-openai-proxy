import { describe, it, expect } from 'vitest';
import { Mutex } from '../src/utils/mutex.js';

describe('Mutex', () => {
    it('should lock and unlock sequentially', async () => {
        const mutex = new Mutex();
        const results: number[] = [];

        const task1 = async () => {
            await mutex.lock();
            results.push(1);
            await new Promise(r => setTimeout(r, 10));
            results.push(2);
            mutex.unlock();
        };

        const task2 = async () => {
            await mutex.lock();
            results.push(3);
            mutex.unlock();
        };

        await Promise.all([task1(), task2()]);

        expect(results).toEqual([1, 2, 3]);
    });
});
