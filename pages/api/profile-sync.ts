// pages/api/profile-sync.ts — Profile ENRICH webhook (person AND resource profiles).
//
// GHL "Profile Changed" workflow → this hook. Runs lib/profiles/pipeline.ts: the profile-tagger for
// profile_type = person, the resource-tagger + company-link guarantee for profile_type = resource,
// each behind its own editable gate. Replaces /api/resource-sync since Resources moved onto Profiles
// (2026-10-23, docs/sprints/profiles-resources-merge.md). Wix is frozen, so nothing is synced there.
//
// Auth: shared secret in `x-webhook-secret` header (or `?secret=`) vs WIX_SYNC_WEBHOOK_SECRET (the
// same secret the other GHL hooks use). Body: { "recordId": "{{custom_objects.profiles.id}}" } —
// the OBJECT KEY path; GHL rejects a generic {{record.id}}. ?dryRun=1 previews, ?echo=1 shows the
// payload GHL sent and runs nothing.
//
// RESPONDS 202 IMMEDIATELY and finishes in the background — the AI tagger exceeds GHL's webhook
// timeout (lib/webhooks/fastAck.ts).

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalog } from '@/lib/ghl/catalogCache';
import { hasDatabase } from '@/lib/db';
import { runProfilePipeline } from '@/lib/profiles/pipeline';
import { ackAndRun, wantsAsync } from '@/lib/webhooks/fastAck';

const PRO_OBJ = 'custom_objects.profiles';

/** A GHL object id: 24 chars of base62. Loose enough to match, tight enough to not match a name. */
const GHL_ID = /^[A-Za-z0-9]{20,26}$/;

/** Keys that hold an id but NOT the record's own id — never mistake these for the record. */
const NOT_RECORD_ID = new Set([
  'locationid', 'location_id', 'contactid', 'contact_id', 'userid', 'user_id', 'companyid',
  'company_id', 'workflowid', 'workflow_id', 'objectid', 'object_id', 'businessid', 'business_id',
  'assignedto', 'associationid', 'association_id', 'eventid', 'event_id', 'traceid', 'trace_id',
]);

/**
 * The record id, from the explicit places first, then by deep-scanning the payload.
 *
 * The scan exists because GHL's custom-object trigger payload shape is undocumented and the
 * merge field we assumed (`{{record.id}}`) is not valid. Prefer keys that mention "record", then
 * any remaining id-ish key that isn't in NOT_RECORD_ID. Returns the source key too, so the
 * response says how it was found instead of silently guessing.
 */
function extractRecordId(req: NextApiRequest): { id?: string; via?: string } {
  const b: any = req.body ?? {};

  const explicit: Array<[string, unknown]> = [
    ['body.recordId', b.recordId],
    ['body.record_id', b.record_id],
    ['body.record.id', b.record?.id],
    ['body.record.recordId', b.record?.recordId],
    ['body.id', b.id],
    ['query.recordId', req.query.recordId],
    ['query.id', req.query.id],
  ];
  for (const [via, v] of explicit) {
    if (typeof v === 'string' && v.trim() && !v.includes('{{')) return { id: v.trim(), via };
  }

  // Deep scan: collect every plausible id, preferring ones under a "record"-ish key.
  const hits: Array<{ id: string; via: string; score: number }> = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1)); return; }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      const here = path ? `${path}.${k}` : k;
      if (typeof v === 'string' && GHL_ID.test(v.trim()) && !v.includes('{{')) {
        const isIdKey = lk === 'id' || lk.endsWith('id');
        if (isIdKey && !NOT_RECORD_ID.has(lk)) {
          const score = /record/.test(here.toLowerCase()) ? 2 : lk === 'id' ? 1 : 0;
          hits.push({ id: v.trim(), via: `scan:${here}`, score });
        }
      } else {
        walk(v, here, depth + 1);
      }
    }
  };
  walk(b, '', 0);
  hits.sort((a, z) => z.score - a.score);
  return hits[0] ? { id: hits[0].id, via: hits[0].via } : {};
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.WIX_SYNC_WEBHOOK_SECRET;
  const provided = (req.headers['x-webhook-secret'] as string) || (req.query.secret as string);
  if (!secret || provided !== secret) return res.status(401).json({ error: 'unauthorized' });

  // ?echo=1 — diagnostic: report exactly what GHL sent, run nothing. Use this once from the GHL
  // workflow to discover the real payload shape, then remove the flag.
  if (req.query.echo === '1') {
    const found = extractRecordId(req);
    return res.status(200).json({
      ok: true, echo: true, method: req.method,
      contentType: req.headers['content-type'] ?? null,
      query: req.query, body: req.body ?? null,
      wouldUseRecordId: found.id ?? null, foundVia: found.via ?? null,
    });
  }

  if (!hasDatabase) return res.status(503).json({ error: 'database not configured' });

  const { id: recordId, via } = extractRecordId(req);
  if (!recordId) {
    // Say what arrived, so a bad merge field is obvious instead of a bare 400.
    return res.status(400).json({
      error: 'recordId required — no record id found in the payload',
      hint: 'Re-send with ?echo=1 to see the payload GHL delivered, then map the right field.',
      receivedKeys: Object.keys((req.body as any) ?? {}),
    });
  }
  const dryRun = req.query.dryRun === '1' || (req.body && req.body.dryRun === true);

  const runWork = async () => {
    const catalog = await getCatalog(PRO_OBJ);
    const r = await runProfilePipeline(String(recordId), catalog, { apply: !dryRun });
    return { ok: true, dryRun, recordId, foundVia: via, kind: r.kind, status: r.status, enrich: r.enrich, companyLink: r.companyLink };
  };

  // A human/script asking for the result waits for it; a GHL webhook must not (the AI tagger is slow).
  if (!wantsAsync(req)) {
    try {
      return res.status(200).json(await runWork());
    } catch (e: any) {
      console.error('profile-sync error:', e);
      return res.status(500).json({ error: e?.message ?? 'profile sync failed' });
    }
  }

  ackAndRun(res, runWork, { label: 'profile-sync', detail: { recordId, foundVia: via } });
  return;
}
