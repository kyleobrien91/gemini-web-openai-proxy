import { BlobCache, blobCache, BlobCacheEntry } from './blob-cache.js';
import { CDPConnection } from './connection.js';
import { UploadableFile } from '../prompt/file-extractor.js';

export interface UploadedBlob extends BlobCacheEntry {
  sha256: string;
}

export interface ScottyUploaderOptions {
  cache?: BlobCache;
}

interface RuntimeEvaluationResult {
  result?: {
    value?: any;
  };
  value?: any;
}

function serialiseForBrowser(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export class ScottyUploader {
  private readonly cdp: CDPConnection;
  private readonly cache: BlobCache;

  constructor(cdp: CDPConnection, options: ScottyUploaderOptions = {}) {
    this.cdp = cdp;
    this.cache = options.cache ?? blobCache;
  }

  async upload(file: UploadableFile, signal?: AbortSignal): Promise<UploadedBlob> {
    const typeCode = file.mimeType.startsWith('image/') ? 1 : 16;
    const cached = this.cache.get(file.sha256);
    if (cached) {
      return {
        ...cached,
        sha256: file.sha256,
        filename: file.filename,
        mimeType: file.mimeType,
        typeCode,
      };
    }

    if (signal?.aborted) {
      throw new Error('Upload cancelled');
    }

    const base64Data = file.bytes.toString('base64');
    const input = {
      filename: file.filename,
      mimeType: file.mimeType,
      dataBase64: base64Data,
      typeCode,
    };

    const script = `
      (async function(input) {
        const decodeBase64 = (value) => {
          const binary = atob(value);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          return bytes;
        };

        const fileBytes = decodeBase64(input.dataBase64);

        // 1. Resumable start handshake
        const startResponse = await fetch('https://push.clients6.google.com/upload/', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(fileBytes.length),
            'X-Tenant-Id': 'bard-storage',
            'Push-ID': 'feeds/mcudyrk2a4khkz',
            'X-Client-Pctx': 'CgcSBWjK7pYx'
          },
          body: 'File name: ' + input.filename
        });

        if (!startResponse.ok) {
          throw new Error('Scotty upload start failed: HTTP ' + startResponse.status);
        }

        const uploadUrl =
          startResponse.headers.get('x-goog-upload-url') ||
          startResponse.headers.get('x-goog-upload-control-url');

        if (!uploadUrl) {
          throw new Error('Scotty start response missing x-goog-upload-url header');
        }

        // 2. Binary upload and finalize
        const uploadResponse = await fetch(uploadUrl, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': '0',
            'X-Tenant-Id': 'bard-storage',
            'Push-ID': 'feeds/mcudyrk2a4khkz',
            'X-Client-Pctx': 'CgcSBWjK7pYx'
          },
          body: fileBytes
        });

        if (!uploadResponse.ok) {
          throw new Error('Scotty upload finalize failed: HTTP ' + uploadResponse.status);
        }

        const responseText = await uploadResponse.text();

        // Extract /contrib_service/ttl_1d/... reference
        const blobMatch = responseText.match(/\\/contrib_service\\/ttl_1d\\/[^"\\s<>]+/);
        if (!blobMatch) {
          throw new Error('Scotty finalize response did not contain a valid BlobStore reference: ' + responseText.slice(0, 200));
        }

        return {
          blobUrl: blobMatch[0],
          mimeType: input.mimeType,
          filename: input.filename,
          typeCode: input.typeCode
        };
      })(${serialiseForBrowser(input)})
    `;

    const response = (await this.cdp.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
    })) as RuntimeEvaluationResult;

    const value = response?.result?.value ?? response?.value;

    if (!value || typeof value !== 'object' || typeof value.blobUrl !== 'string') {
      throw new Error(`Scotty upload failed: ${JSON.stringify(value)}`);
    }

    if (signal?.aborted) {
      throw new Error('Upload cancelled');
    }

    this.cache.set(file.sha256, {
      blobUrl: value.blobUrl,
      mimeType: value.mimeType,
      filename: value.filename,
      typeCode: value.typeCode,
    });

    const entry = this.cache.get(file.sha256);
    if (!entry) {
      throw new Error('BlobStore cache insertion failed after upload');
    }

    return {
      ...entry,
      sha256: file.sha256,
      filename: file.filename,
      mimeType: file.mimeType,
      typeCode,
    };
  }

  async uploadAll(files: UploadableFile[], signal?: AbortSignal): Promise<UploadedBlob[]> {
    const results: UploadedBlob[] = [];
    for (const file of files) {
      if (signal?.aborted) throw new Error('Upload cancelled');
      const uploaded = await this.upload(file, signal);
      results.push(uploaded);
    }
    return results;
  }
}

export function createScottyUploader(cdp: CDPConnection, cache?: BlobCache): ScottyUploader {
  return new ScottyUploader(cdp, { cache });
}
