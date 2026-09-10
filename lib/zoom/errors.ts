// lib/zoom/errors.ts — Zoom API error with the FULL response body in the message.
//
// Same rule as lib/ghl/errors.ts, and Zoom earns it independently: a missing scope comes back as
// `400 {"code":4711,"message":"Invalid access token, does not contain scopes:[...]"}` and the
// message NAMES the scope you are missing. Truncating that turns a 30-second fix into a hunt.

export interface ZoomApiErrorInit {
  status: number;
  body: unknown;
  method: string;
  path: string;
  attempts: number;
}

const BODY_LIMIT = 2000;

export class ZoomApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
  readonly attempts: number;

  constructor(init: ZoomApiErrorInit) {
    const body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    const shown = (body ?? '').slice(0, BODY_LIMIT);
    super(`Zoom ${init.method} ${init.path} failed ${init.status} after ${init.attempts} attempt(s) body=${shown}`);
    this.name = 'ZoomApiError';
    this.status = init.status;
    this.body = init.body;
    this.method = init.method;
    this.path = init.path;
    this.attempts = init.attempts;
  }

  /** Zoom's code 4711 = the token is valid but lacks a scope. Never retryable; always actionable. */
  get isMissingScope(): boolean {
    const b: any = this.body;
    return b?.code === 4711 || /does not contain scopes/i.test(String(b?.message ?? ''));
  }

  get isRetryable(): boolean {
    if (this.isMissingScope) return false;
    return this.status === 429 || this.status >= 500;
  }
}
