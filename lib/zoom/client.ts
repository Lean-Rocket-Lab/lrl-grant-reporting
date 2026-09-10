// lib/zoom/client.ts — the single fetch client every Zoom call goes through.
//
// Mirrors lib/wix/client.ts: token-bucket rate limit, retry/backoff on 429/5xx/network, and an
// OAuth manager that caches the short-lived token and refreshes just before expiry.
//
// Zoom's Server-to-Server grant is `account_credentials` with HTTP Basic (client id : secret) and
// the account id as a QUERY param — not a JSON body, unlike Wix. Tokens last one hour.
//
// Rate limits are per ACCOUNT and scale with plan (LRL is Pro: Light 30/s, Medium 20/s, Heavy
// 10/s). The default here is deliberately far below that — the nightly is not latency-sensitive
// and a shared limiter keeps a backfill from starving the interactive path.

import { getZoomConfig, ZoomConfig } from './config';
import { ZoomApiError } from './errors';

export interface ZoomRequestOptions {
  method?: string;
  /** Path beginning with "/", relative to the v2 base, e.g. "/past_meetings/123/instances". */
  path: string;
  params?: Record<string, string | number | undefined>;
  body?: unknown;
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = Number(process.env.ZOOM_MAX_ATTEMPTS) || 5;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 16000;
/** Refresh the access token this many ms before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const MAX_RPS = Number(process.env.ZOOM_MAX_RPS) || 4;
class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly rate: number, private readonly capacity: number) {
    this.tokens = capacity;
  }
  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }
  async acquire(): Promise<void> {
    this.refill();
    while (this.tokens < 1) {
      const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
      await sleep(waitMs);
      this.refill();
    }
    this.tokens -= 1;
  }
}
const limiter = new TokenBucket(MAX_RPS, MAX_RPS);

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Encode a meeting UUID for use in a path segment.
 *
 * ⚠️ Measured trap: a UUID that starts with "/" or contains "//" must be DOUBLE url-encoded or
 * Zoom answers "Meeting does not exist" — a wrong-looking error for a right-looking id. Every
 * other UUID needs single encoding. Getting this wrong looks like missing data, not a bug.
 */
export function encodeMeetingUuid(uuid: string): string {
  const once = encodeURIComponent(uuid);
  return uuid.startsWith('/') || uuid.includes('//') ? encodeURIComponent(once) : once;
}

export class ZoomClient {
  readonly config: ZoomConfig;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(config?: ZoomConfig) {
    this.config = config ?? getZoomConfig();
  }

  get accountId(): string {
    return this.config.accountId;
  }

  /** Resolve a bearer token: cached until just before expiry, otherwise a fresh exchange. */
  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt - TOKEN_SKEW_MS) {
      return this.token.value;
    }
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const url = `${this.config.tokenUrl}?grant_type=account_credentials&account_id=${encodeURIComponent(this.config.accountId)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'User-Agent': this.config.userAgent },
    });
    const text = await res.text();
    const parsed = parseJson(text) as { access_token?: string; expires_in?: number };
    if (!res.ok || !parsed?.access_token) {
      throw new ZoomApiError({ status: res.status, body: parsed ?? text, method: 'POST', path: '/oauth/token', attempts: 1 });
    }
    this.token = {
      value: parsed.access_token,
      expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  private buildUrl(opts: ZoomRequestOptions): string {
    const isAbsolute = /^https?:\/\//i.test(opts.path);
    const url = new URL(isAbsolute ? opts.path : `${this.config.baseUrl}${opts.path}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** Core request with retry. Returns parsed JSON (typed as T). */
  async request<T = any>(opts: ZoomRequestOptions): Promise<T> {
    const method = opts.method ?? 'GET';
    const url = this.buildUrl(opts);
    const hasBody = opts.body !== undefined && opts.body !== null;
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    let lastError: unknown;
    let refreshed = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await limiter.acquire();
      let status = 0;
      let bodyText = '';
      let retryAfterMs: number | null = null;

      try {
        const token = await this.accessToken(refreshed);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': this.config.userAgent,
        };
        if (hasBody) headers['Content-Type'] = 'application/json';

        const res = await fetch(url, {
          method,
          headers,
          body: hasBody ? JSON.stringify(opts.body) : undefined,
        });
        status = res.status;
        bodyText = await res.text();

        if (res.ok) return parseJson(bodyText) as T;

        // A 401 on a token we believed was fresh: exchange once more before giving up. Zoom can
        // invalidate a token early when the app's scopes change, which happens during setup.
        if (status === 401 && !refreshed) {
          refreshed = true;
          this.token = null;
          continue;
        }

        const ra = res.headers.get('retry-after');
        if (ra) retryAfterMs = Number(ra) * 1000;

        const err = new ZoomApiError({ status, body: parseJson(bodyText), method, path: opts.path, attempts: attempt });
        // A missing scope will fail identically forever; retrying wastes minutes and buries the
        // one message that says which scope to add.
        if (!err.isRetryable || attempt === maxAttempts) throw err;
        lastError = err;
      } catch (e) {
        if (e instanceof ZoomApiError) {
          if (!e.isRetryable || attempt === maxAttempts) throw e;
          lastError = e;
        } else {
          // Network/DNS/abort — retryable.
          if (attempt === maxAttempts) throw e;
          lastError = e;
        }
      }

      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      await sleep(retryAfterMs ?? backoff + jitter);
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

let _default: ZoomClient | null = null;
export function zoom(): ZoomClient {
  if (!_default) _default = new ZoomClient();
  return _default;
}
export function resetDefaultZoomClient(): void {
  _default = null;
}
