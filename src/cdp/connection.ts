import WebSocket from 'ws';
import { CDPTarget, CDPMessage } from '../types/cdp.js';
import { config } from '../config.js';

export class CDPConnection {
  private ws: WebSocket | null = null;
  private messageId = 1;
  private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private eventListeners = new Map<string, Set<(params: any) => void>>();
  private disconnectListeners: Set<() => void> = new Set();
  public targetId: string | null = null;

  async discoverTarget(): Promise<CDPTarget> {
    // If we already established ownership of a specific target, try to find it again
    // to ensure it still exists and hasn't been closed.

    const response = await fetch(`http://${config.cdpHost}:${config.cdpPort}/json`);
    if (!response.ok) {
      throw new Error(`Failed to discover targets: ${response.statusText}`);
    }
    const targets: CDPTarget[] = await response.json();

    let target: CDPTarget | undefined;

    if (this.targetId) {
        target = targets.find(t => t.id === this.targetId);
        if (!target) {
            // Our owned tab was closed. Reset ownership.
            this.targetId = null;
        }
    }

    if (!target) {
        // Find an existing Gemini app tab, or create one
        target = targets.find(t => t.url.includes('gemini.google.com/app'));

        if (!target) {
            // Attempt to create a new tab via CDP
            const newTabRes = await fetch(`http://${config.cdpHost}:${config.cdpPort}/json/new?https://gemini.google.com/app`, { method: 'PUT' });
            if (newTabRes.ok) {
                 target = await newTabRes.json();
            }
        }
    }

    if (!target) {
      throw new Error('No active Gemini target found and failed to create one. Please authenticate Gemini in your browser.');
    }

    this.targetId = target.id;
    return target;
  }

  async connect(debuggerUrl: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        return; // Already connected
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(debuggerUrl);

      this.ws.on('open', async () => {
        // Explicitly enable Page domain upon connection
        try {
            await this.send('Page.enable');
        } catch (e) {
            console.error("Failed to enable Page domain", e);
        }
        resolve();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString()) as CDPMessage;
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const { resolve, reject } = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            reject(msg.error);
          } else {
            resolve(msg.result);
          }
        } else if (msg.method) {
          const listeners = this.eventListeners.get(msg.method);
          if (listeners) {
            listeners.forEach(fn => fn(msg.params));
          }
        }
      });

      this.ws.on('error', (err) => {
        this.rejectAllPending(err);
        this.notifyDisconnect();
        reject(err);
      });

      this.ws.on('close', () => {
        this.ws = null;
        this.rejectAllPending(new Error("CDP WebSocket closed"));
        this.notifyDisconnect();
      });
    });
  }

  private rejectAllPending(err: any) {
     for (const [id, req] of this.pendingRequests.entries()) {
         req.reject(err);
         this.pendingRequests.delete(id);
     }
  }

  private notifyDisconnect() {
     for (const listener of this.disconnectListeners) {
         listener();
     }
  }

  onDisconnect(listener: () => void) {
     this.disconnectListeners.add(listener);
  }

  offDisconnect(listener: () => void) {
     this.disconnectListeners.delete(listener);
  }

  async send(method: string, params: any = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    const id = this.messageId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, callback: (params: any) => void) {
    if (!this.eventListeners.has(method)) {
      this.eventListeners.set(method, new Set());
    }
    this.eventListeners.get(method)!.add(callback);
  }

  off(method: string, callback: (params: any) => void) {
    const listeners = this.eventListeners.get(method);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
