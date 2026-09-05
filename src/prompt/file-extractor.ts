import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { MessageContentPart, Message } from '../types/openai.js';

export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB
export const MAX_REQUEST_BYTES = 100 * 1024 * 1024; // 100MB
export const MAX_FILES_PER_REQUEST = 10;

export const SUPPORTED_MIME_TYPES = new Map<string, string>([
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['text/markdown', '.md'],
  ['text/x-python', '.py'],
  ['text/javascript', '.js'],
  ['text/typescript', '.ts'],
  ['text/html', '.html'],
  ['text/css', '.css'],
  ['text/csv', '.csv'],
  ['application/json', '.json'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
]);

export const EXTENSION_TO_MIME = new Map<string, string>([
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.py', 'text/x-python'],
  ['.js', 'text/javascript'],
  ['.ts', 'text/typescript'],
  ['.html', 'text/html'],
  ['.css', 'text/css'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

export interface UploadableFile {
  bytes: Buffer;
  mimeType: string;
  filename: string;
  sha256: string;
  source: 'data-uri' | 'remote-url';
}

export interface ExtractedPart {
  kind: 'text' | 'file';
  text?: string;
  file?: UploadableFile;
}

export interface ExtractedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  parts: ExtractedPart[];
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface ExtractionResult {
  messages: ExtractedMessage[];
  files: UploadableFile[];
  totalBytes: number;
}

export class RequestExtractionError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'RequestExtractionError';
    this.statusCode = statusCode;
  }
}

export function normaliseMimeType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.split(';', 1)[0].trim().toLowerCase();
  return SUPPORTED_MIME_TYPES.has(normalized) ? normalized : undefined;
}

export function extensionForFilename(filename: string): string | undefined {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return undefined;
  return filename.slice(lastDot).toLowerCase();
}

export function sanitizeFilename(filename: string | undefined, fallback: string): string {
  const candidate = (filename || fallback).trim();
  const sanitized = candidate
    .replace(/[\\/:"*?<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 255);
  return sanitized || fallback;
}

export function extensionForMimeType(mimeType: string): string {
  const extension = SUPPORTED_MIME_TYPES.get(mimeType);
  if (!extension) {
    throw new RequestExtractionError(`Unsupported MIME type: ${mimeType}`);
  }
  return extension;
}

export interface MagicSignature {
  mimeType: string;
  matches: (bytes: Buffer) => boolean;
}

export const MAGIC_SIGNATURES: MagicSignature[] = [
  {
    mimeType: 'application/pdf',
    matches: (bytes) => bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-',
  },
  {
    mimeType: 'image/png',
    matches: (bytes) =>
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mimeType: 'image/jpeg',
    matches: (bytes) =>
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff,
  },
  {
    mimeType: 'image/gif',
    matches: (bytes) => {
      if (bytes.length < 6) return false;
      const header = bytes.subarray(0, 6).toString('ascii');
      return header === 'GIF87a' || header === 'GIF89a';
    },
  },
  {
    mimeType: 'image/webp',
    matches: (bytes) =>
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

export function detectMagicMimeType(bytes: Buffer): string | undefined {
  for (const signature of MAGIC_SIGNATURES) {
    if (signature.matches(bytes)) {
      return signature.mimeType;
    }
  }
  return undefined;
}

export function parseDataUri(uri: string): { mimeType: string; bytes: Buffer } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(uri);
  if (!match) {
    throw new RequestExtractionError('Invalid data URI');
  }

  const mimeType = normaliseMimeType(match[1] || undefined);
  if (!mimeType) {
    throw new RequestExtractionError(`Unsupported or missing data URI MIME type: ${match[1] || 'unknown'}`);
  }

  const encoded = match[3];

  try {
    let bytes: Buffer;
    if (match[2]) {
      const normalized = encoded.replace(/\s/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
        throw new Error('Invalid base64 alphabet');
      }
      bytes = Buffer.from(normalized, 'base64');
    } else {
      bytes = Buffer.from(decodeURIComponent(encoded), 'utf8');
    }

    if (bytes.length === 0) {
      throw new Error('Decoded payload is empty');
    }

    if (bytes.length > MAX_FILE_BYTES) {
      throw new RequestExtractionError(`File exceeds maximum size of ${MAX_FILE_BYTES} bytes`);
    }

    return { mimeType, bytes };
  } catch (error) {
    if (error instanceof RequestExtractionError) throw error;
    throw new RequestExtractionError(`Invalid data URI payload: ${(error as Error).message}`);
  }
}

export function isIpv4PrivateOrReserved(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a === 0 ||
    a >= 224
  );
}

export function isIpv6PrivateOrReserved(ip: string): boolean {
  const normalized = ip.toLowerCase().split('%', 1)[0];
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return isIpv4PrivateOrReserved(mapped);
  }
  return false;
}

export async function resolveAndValidateHost(hostname: string): Promise<void> {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
  if (
    normalizedHostname === 'localhost' ||
    normalizedHostname === 'metadata.google.internal' ||
    normalizedHostname === 'metadata.google' ||
    normalizedHostname.endsWith('.localhost')
  ) {
    throw new RequestExtractionError('Remote URL hostname is not permitted');
  }

  const addresses = await lookup(normalizedHostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new RequestExtractionError('Remote URL hostname could not be resolved');
  }

  for (const address of addresses) {
    if (
      address.family === 4
        ? isIpv4PrivateOrReserved(address.address)
        : isIpv6PrivateOrReserved(address.address)
    ) {
      throw new RequestExtractionError(`Remote URL resolves to a private or reserved address: ${address.address}`);
    }
  }
}

export async function fetchRemoteFile(urlString: string): Promise<{ bytes: Buffer; mimeType: string; filename: string }> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(urlString);
  } catch {
    throw new RequestExtractionError('Invalid file URL');
  }

  for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
      throw new RequestExtractionError('Only HTTP and HTTPS file URLs are supported');
    }

    await resolveAndValidateHost(currentUrl.hostname);

    const response = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: '*/*',
        'user-agent': 'gemini-web-openai-proxy/1.0',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      if (redirect === 5) {
        throw new RequestExtractionError('Too many redirects while fetching file');
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new RequestExtractionError('Remote server returned an invalid redirect');
      }
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        throw new RequestExtractionError('Remote server returned an invalid redirect URL');
      }
      continue;
    }

    if (!response.ok) {
      throw new RequestExtractionError(`Failed to fetch remote file: HTTP ${response.status}`);
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const declaredLength = Number.parseInt(contentLength, 10);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
        throw new RequestExtractionError(`Remote file exceeds maximum size of ${MAX_FILE_BYTES} bytes`);
      }
    }

    if (!response.body) {
      throw new RequestExtractionError('Remote response has no body');
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = Buffer.from(result.value);
        totalBytes += chunk.length;
        if (totalBytes > MAX_FILE_BYTES) {
          throw new RequestExtractionError(`Remote file exceeds maximum size of ${MAX_FILE_BYTES} bytes`);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = Buffer.concat(chunks, totalBytes);
    const headerMime = normaliseMimeType(response.headers.get('content-type') || undefined);
    const magicMime = detectMagicMimeType(bytes);
    let mimeType = magicMime || headerMime;

    if (!mimeType) {
      const pathname = currentUrl.pathname.toLowerCase();
      const extension = pathname.slice(pathname.lastIndexOf('.'));
      mimeType = EXTENSION_TO_MIME.get(extension);
    }

    if (!mimeType) {
      throw new RequestExtractionError('Unable to determine a supported MIME type for remote file');
    }

    if (magicMime && headerMime && magicMime !== headerMime) {
      throw new RequestExtractionError(`Remote file MIME mismatch: HTTP header ${headerMime}, detected ${magicMime}`);
    }

    const filenameFromPath = decodeURIComponent(
      currentUrl.pathname.slice(currentUrl.pathname.lastIndexOf('/') + 1),
    );

    const filename = sanitizeFilename(
      filenameFromPath || undefined,
      `attachment${extensionForMimeType(mimeType)}`,
    );

    return { bytes, mimeType, filename };
  }

  throw new RequestExtractionError('Failed to resolve remote file URL');
}

export function validateBytesAndMime(bytes: Buffer, declaredMimeType: string | undefined, filename: string): string {
  if (bytes.length === 0) {
    throw new RequestExtractionError('File payload is empty');
  }

  if (bytes.length > MAX_FILE_BYTES) {
    throw new RequestExtractionError(`File exceeds maximum size of ${MAX_FILE_BYTES} bytes`);
  }

  const filenameExtension = extensionForFilename(filename);
  const detectedMimeType = detectMagicMimeType(bytes);

  if (declaredMimeType) {
    if (!SUPPORTED_MIME_TYPES.has(declaredMimeType)) {
      throw new RequestExtractionError(`Unsupported MIME type: ${declaredMimeType}`);
    }

    if (detectedMimeType && detectedMimeType !== declaredMimeType) {
      throw new RequestExtractionError(`File MIME mismatch: declared ${declaredMimeType}, detected ${detectedMimeType}`);
    }

    return declaredMimeType;
  }

  if (detectedMimeType) {
    return detectedMimeType;
  }

  if (filenameExtension) {
    const extensionMime = EXTENSION_TO_MIME.get(filenameExtension);
    if (extensionMime) return extensionMime;
  }

  return 'application/octet-stream';
}

export function createExtractedFile(
  bytes: Buffer,
  mimeType: string,
  filename: string,
  source: UploadableFile['source'],
): UploadableFile {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    bytes,
    mimeType,
    filename: sanitizeFilename(filename, `attachment${extensionForMimeType(mimeType)}`),
    sha256,
    source,
  };
}

export async function resolveFilePart(part: Extract<MessageContentPart, { type: 'file' | 'image_url' }>): Promise<UploadableFile> {
  if (part.type === 'image_url') {
    const url = part.image_url.url;
    if (url.startsWith('data:')) {
      const parsed = parseDataUri(url);
      const mimeType = validateBytesAndMime(parsed.bytes, parsed.mimeType, `image${extensionForMimeType(parsed.mimeType)}`);
      return createExtractedFile(parsed.bytes, mimeType, `image${extensionForMimeType(mimeType)}`, 'data-uri');
    }

    const remote = await fetchRemoteFile(url);
    if (!remote.mimeType.startsWith('image/')) {
      throw new RequestExtractionError(`image_url resolved to unsupported non-image MIME type ${remote.mimeType}`);
    }
    const mimeType = validateBytesAndMime(remote.bytes, remote.mimeType, remote.filename);
    return createExtractedFile(remote.bytes, mimeType, remote.filename, 'remote-url');
  }

  const file = part.file;
  if (file.data) {
    let bytes: Buffer;
    let mimeTypeCandidate: string | undefined;

    if (file.data.startsWith('data:')) {
      const parsed = parseDataUri(file.data);
      bytes = parsed.bytes;
      mimeTypeCandidate = parsed.mimeType;
    } else {
      try {
        const normalized = file.data.replace(/\s/g, '');
        bytes = Buffer.from(normalized, 'base64');
        if (bytes.length === 0) throw new Error('Decoded payload is empty');
        mimeTypeCandidate = normaliseMimeType(file.mime_type);
      } catch {
        throw new RequestExtractionError('Invalid base64 file data');
      }
    }

    const filename = sanitizeFilename(file.name, `attachment${extensionForMimeType(mimeTypeCandidate || 'application/pdf')}`);
    const mimeType = validateBytesAndMime(bytes, mimeTypeCandidate, filename);
    return createExtractedFile(bytes, mimeType, filename, 'data-uri');
  }

  if (!file.url) {
    throw new RequestExtractionError('file.url or file.data is required');
  }

  const remote = await fetchRemoteFile(file.url);
  if (file.mime_type && normaliseMimeType(file.mime_type) !== remote.mimeType) {
    throw new RequestExtractionError(`Declared MIME type ${file.mime_type} does not match remote MIME type ${remote.mimeType}`);
  }

  const filename = sanitizeFilename(file.name || remote.filename, remote.filename);
  const mimeType = validateBytesAndMime(remote.bytes, normaliseMimeType(file.mime_type) || remote.mimeType, filename);
  return createExtractedFile(remote.bytes, mimeType, filename, 'remote-url');
}

export async function extractMultimodalMessages(messages: readonly Message[]): Promise<ExtractionResult> {
  let totalBytes = 0;
  let fileCount = 0;
  const filesByHash = new Map<string, UploadableFile>();
  const extractedMessages: ExtractedMessage[] = [];

  for (const message of messages) {
    if (typeof message.content === 'string' || message.content == null) {
      extractedMessages.push({
        role: message.role,
        content: message.content ?? null,
        parts: message.content ? [{ kind: 'text', text: message.content }] : [],
        name: message.name,
        tool_call_id: message.tool_call_id,
        tool_calls: message.tool_calls,
      });
      continue;
    }

    const parts: ExtractedPart[] = [];
    const textParts: string[] = [];

    for (const part of message.content) {
      if (part.type === 'text') {
        parts.push({ kind: 'text', text: part.text });
        textParts.push(part.text);
        continue;
      }

      fileCount += 1;
      if (fileCount > MAX_FILES_PER_REQUEST) {
        throw new RequestExtractionError(`A maximum of ${MAX_FILES_PER_REQUEST} files is supported per request`);
      }

      const file = await resolveFilePart(part);
      totalBytes += file.bytes.length;

      if (totalBytes > MAX_REQUEST_BYTES) {
        throw new RequestExtractionError(`Cumulative file size exceeds ${MAX_REQUEST_BYTES} bytes`);
      }

      const existing = filesByHash.get(file.sha256);
      const resolvedFile = existing || file;
      if (!existing) {
        filesByHash.set(file.sha256, file);
      }

      parts.push({ kind: 'file', file: resolvedFile });
    }

    extractedMessages.push({
      role: message.role,
      content: textParts.join('\n'),
      parts,
      name: message.name,
      tool_call_id: message.tool_call_id,
      tool_calls: message.tool_calls,
    });
  }

  return {
    messages: extractedMessages,
    files: [...filesByHash.values()],
    totalBytes,
  };
}
