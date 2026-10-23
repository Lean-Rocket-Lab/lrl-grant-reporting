// pages/api/resource-sync.ts — RETIRED 2026-10-23.
//
// Resources moved onto the Profiles object (profile_type = resource;
// docs/sprints/profiles-resources-merge.md). The custom_objects.resources object is a frozen archive
// and Wix is frozen until the new site launches, so this hook does nothing. It is no longer on the
// middleware's self-enforcing allowlist, so an anonymous GHL call is refused by the login gate before
// it gets here; a signed-in caller gets 410. Turn the GHL "Resource Changed" workflow off.
//
// The pre-merge implementation (enrich + company link + Wix Resources sync) is in git history and in
// lib/wix-sync/pipeline.ts (runResourcePipeline), which nothing calls any more.

import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  return res.status(410).json({
    error: 'gone',
    detail: 'Resources moved onto Profiles (2026-10-23). Turn off the GHL "Resource Changed" workflow; use /api/profile-sync.',
  });
}
