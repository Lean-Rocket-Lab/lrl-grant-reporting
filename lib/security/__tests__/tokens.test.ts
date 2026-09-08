// Pins the signing primitives every credential-bearing artifact in this app depends on.
//
// Originally written for the client rescore links (scrapped 2026-09-08 in favour of a GHL-hosted
// form). It stays because `lib/security/hmac.ts` still signs the STAFF SESSION COOKIE, which is now
// the only thing standing between the internet and every credential LRL owns. A regression here is
// not a broken test, it is an open front door.

import { describe, expect, it } from 'vitest';
import { makeSigned, verifySigned, timingSafeEqual, b64uEncode, b64uDecodeToString } from '../hmac';

const SECRET = 'test-secret-do-not-use';

describe('hmac', () => {
  it('round-trips base64url without padding', () => {
    expect(b64uDecodeToString(b64uEncode('hello ünïcode ??'))).toBe('hello ünïcode ??');
    expect(b64uEncode('any')).not.toContain('=');
  });

  it('verifies a signature it made', async () => {
    const t = await makeSigned({ a: 1, exp: 9999999999 }, SECRET);
    expect(await verifySigned<any>(t, SECRET)).toMatchObject({ a: 1 });
  });

  it('rejects a tampered payload', async () => {
    const t = await makeSigned({ a: 1, exp: 9999999999 }, SECRET);
    const [body, sig] = t.split('.');
    const evil = b64uEncode(JSON.stringify({ a: 2, exp: 9999999999 }));
    expect(await verifySigned(`${evil}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects a wrong secret, a malformed token, and an empty one', async () => {
    const t = await makeSigned({ exp: 9999999999 }, SECRET);
    expect(await verifySigned(t, 'other-secret')).toBeNull();
    expect(await verifySigned('no-dot-here', SECRET)).toBeNull();
    expect(await verifySigned('.', SECRET)).toBeNull();
    expect(await verifySigned('', SECRET)).toBeNull();
    expect(await verifySigned(undefined, SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const t = await makeSigned({ exp: 1000 }, SECRET);
    expect(await verifySigned(t, SECRET)).toBeNull();
    // ...and accepts it when it is still in date.
    expect(await verifySigned(t, SECRET, 999)).toMatchObject({ exp: 1000 });
  });

  it('timingSafeEqual is correct as well as constant-time', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });
});
