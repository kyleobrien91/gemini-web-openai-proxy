export interface BlobCacheEntry {
  blobUrl: string;
  mimeType: string;
  filename: string;
  typeCode: number;
  createdAt: number;
}

interface InternalEntry extends BlobCacheEntry {
  expiresAt: number;
  lastAccessedAt: number;
}

export interface BlobCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

export class BlobCache {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: BlobCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 22 * 60 * 60 * 1000; // 22 hours (Google TTL is 24h)
    this.maxEntries = options.maxEntries ?? 256;
  }

  get(sha256: string): BlobCacheEntry | undefined {
    const entry = this.entries.get(sha256);
    if (!entry) return undefined;

    const now = Date.now();
    if (entry.expiresAt <= now) {
      this.entries.delete(sha256);
      return undefined;
    }

    entry.lastAccessedAt = now;
    // Refresh LRU ordering
    this.entries.delete(sha256);
    this.entries.set(sha256, entry);

    return {
      blobUrl: entry.blobUrl,
      mimeType: entry.mimeType,
      filename: entry.filename,
      typeCode: entry.typeCode,
      createdAt: entry.createdAt,
    };
  }

  set(sha256: string, value: Omit<BlobCacheEntry, 'createdAt'>): void {
    const now = Date.now();
    this.entries.delete(sha256);
    this.entries.set(sha256, {
      ...value,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastAccessedAt: now,
    });

    this.evictExpired(now);

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }

  delete(sha256: string): boolean {
    return this.entries.delete(sha256);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    this.evictExpired(Date.now());
    return this.entries.size;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

export const blobCache = new BlobCache();
