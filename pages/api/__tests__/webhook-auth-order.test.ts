// A static source scan, not a behaviour test, and that is the point.
//
// The 7 webhook receivers are ALLOWLISTED in middleware.ts as "self-enforcing", so each one is its
// own front door. On 2026-09-08, re-probing production after the middleware deploy, three of them
// returned 200 to an anonymous caller: `?echo=1` was handled BEFORE the secret check in form-sync,
// appointment-sync and opportunity-sync. Nothing of ours leaked (echo reflects the caller's own
// body) but a diagnostic sitting in front of auth is one edit away from leaking something real.
//
// This pins the ordering for every self-enforcing route at once, so a new handler — or a new early
// return added to an existing one — cannot reintroduce it quietly.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Must match SELF_ENFORCING in middleware.ts. A route added there needs adding here. */
const SELF_ENFORCING = [
  'form-sync.ts',
  'sync/up.ts',
  'wix-sync.ts',
  'appointment-sync.ts',
  'opportunity-sync.ts',
  'resource-sync.ts',
  'readiness-tag.ts',
];

const API_DIR = join(process.cwd(), 'pages', 'api');

/** Line index of the first line that rejects an unauthenticated caller. */
function authLine(lines: string[]): number {
  return lines.findIndex(
    (l) => /res\.status\(401\)/.test(l) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'),
  );
}

/** Line index of the first line that hands a 200 back, ignoring comments. */
function firstSuccessLine(lines: string[]): number {
  return lines.findIndex((l) => {
    const t = l.trimStart();
    if (t.startsWith('//') || t.startsWith('*')) return false;
    return /res\.status\(200\)/.test(t);
  });
}

describe('self-enforcing webhook routes', () => {
  for (const file of SELF_ENFORCING) {
    describe(file, () => {
      const src = readFileSync(join(API_DIR, file), 'utf8');
      const lines = src.split('\n');

      it('rejects unauthenticated callers somewhere', () => {
        expect(authLine(lines), `${file} has no 401 path at all`).toBeGreaterThan(-1);
      });

      it('checks auth BEFORE it can return 200', () => {
        const auth = authLine(lines);
        const ok = firstSuccessLine(lines);
        if (ok === -1) return; // no 200 in the file at all
        expect(
          auth,
          `${file}: a 200 is returned on line ${ok + 1}, before the 401 check on line ${auth + 1}. ` +
            'Any early return placed above the secret check is an anonymous endpoint.',
        ).toBeLessThan(ok);
      });

      it('does not fail OPEN when its secret env var is unset', () => {
        // `if (!expected) return true` turns one missing Vercel env var into an anonymous write
        // endpoint. Dev convenience is fine; production must fail closed.
        const failsOpen = /if \(!expected\) return true;/.test(src);
        expect(failsOpen, `${file} treats a missing secret as authorized`).toBe(false);
      });
    });
  }
});
