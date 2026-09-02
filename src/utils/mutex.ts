export class Mutex {
    private queue: ((value: boolean) => void)[] = [];
    private locked = false;

    async lock(signal?: AbortSignal): Promise<boolean> {
        return new Promise((resolve) => {
            if (signal?.aborted) {
                return resolve(false);
            }

            if (!this.locked) {
                this.locked = true;
                resolve(true);
            } else {
                let abortHandler: () => void;
                const releaseFn = (acquired: boolean) => {
                    if (signal) signal.removeEventListener('abort', abortHandler);
                    resolve(acquired);
                };

                if (signal) {
                    abortHandler = () => {
                        // Remove ourselves from queue so we don't acquire later
                        const index = this.queue.indexOf(releaseFn);
                        if (index !== -1) {
                            this.queue.splice(index, 1);
                        }
                        releaseFn(false);
                    };
                    signal.addEventListener('abort', abortHandler);
                }
                this.queue.push(releaseFn);
            }
        });
    }

    unlock(): void {
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            if (next) next(true); // Hand lock directly to next in line
        } else {
            this.locked = false;
        }
    }
}
