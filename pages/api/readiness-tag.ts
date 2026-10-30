// pages/api/readiness-tag.ts — RETIRED 2026-10-30. Kept as a no-op so any GHL workflow still pointing at
// it runs clean instead of erroring.
//
// History: the real-time CONTACT readiness-tagger webhook. Website profiles moved onto
// custom_objects.profiles (2026-10-20) and the contact readiness fields were deleted 2026-10-30;
// Profiles are tagged by profileTagger via /api/profile-sync and the nightly profiles workflow.
// The pre-retirement body is in git history.
//
// Auth unchanged: shared secret in `x-webhook-secret` header (or `?secret=`) vs READINESS_WEBHOOK_SECRET.

import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.READINESS_WEBHOOK_SECRET;
  const provided = (req.headers['x-webhook-secret'] as string) || (req.query.secret as string);
  if (!secret || provided !== secret) return res.status(401).json({ error: 'unauthorized' });

  return res.status(200).json({ ok: true, retired: true, note: 'The contact readiness-tagger is retired; Profiles are tagged via /api/profile-sync. Remove this webhook step from the GHL workflow.' });
}
