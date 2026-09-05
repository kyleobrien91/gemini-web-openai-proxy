import { CDPConnection } from './connection.js';
import { UploadedBlob } from './scotty-uploader.js';

export interface StreamGenerateRequest {
  model: string;
  prompt: string;
  blobs: UploadedBlob[];
}

export interface StreamGenerateHandle {
  waitForCompletion: () => Promise<void>;
  cleanup: () => Promise<void>;
}

function serialiseForBrowser(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export class StreamService {
  private readonly cdp: CDPConnection;

  constructor(cdp: CDPConnection) {
    this.cdp = cdp;
  }

  private async safeAddBinding(name: string) {
    try {
      await this.cdp.send('Runtime.addBinding', { name });
    } catch (e: any) {
      if (
        e.message &&
        (e.message.includes('Binding already exists') ||
          e.message.includes('Binding with that name already exists'))
      ) {
        // Safe to ignore
      } else {
        throw e;
      }
    }
  }

  async streamGenerate(
    turnId: string,
    request: StreamGenerateRequest,
    onToken: (token: string) => void,
    signal?: AbortSignal,
  ): Promise<StreamGenerateHandle> {
    if (signal?.aborted) {
      throw new Error('Request cancelled');
    }

    const emitBindingName = `__proxyStreamEmitToken_${turnId}`;
    await this.safeAddBinding(emitBindingName);

    let bindingHandler: ((event: any) => void) | undefined;
    let onDisconnect: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    let isCleanedUp = false;

    const rollback = async () => {
      if (isCleanedUp) return;
      isCleanedUp = true;

      if (bindingHandler) this.cdp.off('Runtime.bindingCalled', bindingHandler);
      if (onDisconnect) this.cdp.offDisconnect(onDisconnect);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);

      const cleanupScript = `
        const streamState = window['__proxyStreamState_${turnId}'];
        if (streamState) {
          streamState.aborted = true;
          if (streamState.reader) {
            try { streamState.reader.cancel(); } catch (e) {}
          }
          delete window['__proxyStreamState_${turnId}'];
        }
      `;

      try {
        await this.cdp.send('Runtime.evaluate', { expression: cleanupScript, awaitPromise: true });
      } catch (e) {
        // Target may already be closed
      }
    };

    let streamError: Error | null = null;

    const completionPromise = new Promise<void>((resolve, reject) => {
      onAbort = () => {
        rollback().then(() => reject(new Error('Request cancelled')));
      };

      if (signal) {
        if (signal.aborted) {
          return reject(new Error('Request already cancelled'));
        }
        signal.addEventListener('abort', onAbort);
      }

      onDisconnect = () => {
        rollback().then(() => reject(new Error('CDP WebSocket disconnected during stream')));
      };
      this.cdp.onDisconnect(onDisconnect);

      bindingHandler = (event: any) => {
        if (event.name === emitBindingName) {
          try {
            const data = JSON.parse(event.payload);
            if (data.type === 'token') {
              onToken(data.token);
            } else if (data.type === 'complete') {
              resolve();
            } else if (data.type === 'error') {
              streamError = new Error(data.message || 'Stream generation error');
              reject(streamError);
            }
          } catch (err) {
            console.error('Failed to parse stream event payload:', err);
          }
        }
      };

      this.cdp.on('Runtime.bindingCalled', bindingHandler);
    });

    const browserInput = {
      turnId,
      emitBindingName,
      prompt: request.prompt,
      blobs: request.blobs.map((b) => ({
        blobUrl: b.blobUrl,
        mimeType: b.mimeType,
        filename: b.filename,
        typeCode: b.typeCode,
      })),
    };

    const script = `
      (async function(input) {
        const emitBinding = window[input.emitBindingName];
        if (typeof emitBinding !== 'function') {
          return { error: 'EMIT_BINDING_NOT_FOUND' };
        }

        const emit = (type, payload = {}) => {
          try {
            emitBinding(JSON.stringify({ type, ...payload }));
          } catch (e) {}
        };

        const wiz = window['WIZ_global_data'] || {};
        const at = wiz['SNlM0e'];
        const fsid = wiz['FdrFJe'];
        const bl = wiz['cfb2h'];

        if (!at) {
          emit('error', { message: 'Authentication token SNlM0e not found in page context' });
          return { error: 'SNlM0e_NOT_FOUND' };
        }

        const state = {
          aborted: false,
          reader: null
        };
        window['__proxyStreamState_' + input.turnId] = state;

        const attachmentEntries = (input.blobs || []).map(b => [
          [b.blobUrl, b.typeCode, null, b.mimeType],
          b.filename,
          null, null, null, null, null, null, [0]
        ]);

        const innerReq = [
          [
            input.prompt,
            0,
            null,
            attachmentEntries.length > 0 ? attachmentEntries : null,
            null,
            null,
            0
          ],
          ["en-GB"],
          ["", "", "", null, null, null, null, null, null, ""],
          at
        ];

        const fReq = JSON.stringify([null, JSON.stringify(innerReq)]);
        const postBody = new URLSearchParams();
        postBody.append('f.req', fReq);
        postBody.append('at', at);

        const reqId = Math.floor(100000 + Math.random() * 900000);
        const streamUrl = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=' +
          encodeURIComponent(bl || '') +
          '&f.sid=' + encodeURIComponent(fsid || '') +
          '&hl=en-GB&_reqid=' + reqId + '&rt=c';

        try {
          const resp = await fetch(streamUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
            },
            body: postBody.toString(),
            credentials: 'include'
          });

          if (!resp.ok) {
            emit('error', { message: 'StreamGenerate request failed with HTTP ' + resp.status });
            return { error: 'HTTP_' + resp.status };
          }

          const reader = resp.body.getReader();
          state.reader = reader;
          const decoder = new TextDecoder();
          let buffer = '';
          let lastEmittedLength = 0;

          while (true) {
            if (state.aborted) {
              try { reader.cancel(); } catch (e) {}
              break;
            }

            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(\")]}'\") || /^\\d+$/.test(trimmed)) {
                continue;
              }

              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                  for (const item of parsed) {
                    if (Array.isArray(item) && item[0] === 'wrb.fr' && typeof item[2] === 'string') {
                      const inner = JSON.parse(item[2]);
                      if (inner && inner[4] && inner[4][0] && inner[4][0][1] && typeof inner[4][0][1][0] === 'string') {
                        const currentText = inner[4][0][1][0];
                        if (currentText.length > lastEmittedLength) {
                          const delta = currentText.slice(lastEmittedLength);
                          lastEmittedLength = currentText.length;
                          emit('token', { token: delta });
                        }
                      }
                    }
                  }
                }
              } catch (e) {
                // Incomplete JSON fragment, continue buffering
              }
            }
          }

          emit('complete');
          return { success: true, totalLength: lastEmittedLength };
        } catch (err) {
          emit('error', { message: err.message || 'Unknown stream error' });
          return { error: err.message };
        } finally {
          delete window['__proxyStreamState_' + input.turnId];
        }
      })(${serialiseForBrowser(browserInput)})
    `;

    // Trigger asynchronous stream evaluation inside page context
    this.cdp
      .send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
      })
      .catch((err) => {
        // If evaluation fails or drops, notify completion promise
        console.error('StreamService evaluation failed:', err);
      });

    return {
      waitForCompletion: () => completionPromise,
      cleanup: rollback,
    };
  }
}
