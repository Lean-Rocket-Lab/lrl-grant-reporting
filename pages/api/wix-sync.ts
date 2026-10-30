// pages/api/wix-sync.ts — RETIRED 2026-10-30. Kept as a no-op so any GHL workflow still pointing at it
// runs clean instead of erroring.
//
// History: this was the standalone contact ENRICH + Wix Team sync webhook. Wix was retired 2026-10-26
// (WIX_RETIRED in lib/wix/config.ts) and the contact readiness-tagger was retired 2026-10-30, when the
// website-profile fields were deleted from the contact record (profiles live on custom_objects.profiles,
// tagged by profileTagger via /api/profile-sync and the nightly profiles workflow). The pre-retirement
// body is in git history.
//
// Auth unchanged: shared secret in `x-webhook-secret` header (or `?secret=`) vs WIX_SYNC_WEBHOOK_SECRET.

import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.WIX_SYNC_WEBHOOK_SECRET;
  const provided = (req.headers['x-webhook-secret'] as string) || (req.query.secret as string);
  if (!secret || provided !== secret) return res.status(401).json({ error: 'unauthorized' });

  return res.status(200).json({ ok: true, retired: true, note: 'Wix and the contact readiness-tagger are retired; nothing to do. Remove this webhook step from the GHL workflow.' });
}
