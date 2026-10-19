// pages/api/event-registration-sync.ts — a GHL Events registration → a Workshop / Event activity,
// plus server-side conversions to GA4 and LinkedIn. See lib/activities/sources/eventRegistration.ts.
//
// Wire the "Event Conversion Tracking" workflow (trigger: Event Registration Status = Succeeded) with
// a Webhook action:
//     POST https://lrl-grant-reporting.vercel.app/api/event-registration-sync
//     header       x-webhook-secret: <WIX_SYNC_WEBHOOK_SECRET>   (no Vercel bypass needed — 09-02)
//     Custom Data  eventId · eventName · eventStart  → the trigger's event merge fields
// GHL sends its standard payload (contact_id at top level, Custom Data under `customData`); a typed
// JSON body is NOT what arrives. Every delivery logs the payload's event-ish keys, so the first real
// registration shows exactly which merge fields made it.
// `?echo=1` dumps what GHL delivered and runs nothing (send the secret — echo sits behind auth).
// `?dryRun=1` plans the activity and VALIDATES the GA4 hit against GA4's debug endpoint; nothing is
// written or recorded. `?sync=1` waits for the result. `?noConversions=1` ingests the activity only.

import type { NextApiRequest, NextApiResponse } from 'next';
import { ackAndRun, wantsAsync } from '@/lib/webhooks/fastAck';
import { describePayloadShape, extractEventPayload, ingestEventRegistration } from '@/lib/activities/sources/eventRegistration';

function authorized(req: NextApiRequest): boolean {
  const expected = process.env.WIX_SYNC_WEBHOOK_SECRET;
  // Fail CLOSED in production — same rule and same secret as /api/form-sync.
  if (!expected) return process.env.NODE_ENV !== 'production';
  const got = req.headers['x-webhook-secret'] ?? req.query.secret;
  return typeof got === 'string' && got === expected;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.query.echo === '1') return res.status(200).json({ echo: true, query: req.query, body: req.body });

  const { via, ...input } = extractEventPayload(req.body, req.query as Record<string, unknown>);
  // Until the trigger's payload is confirmed live, log its shape on every delivery (keys + event-ish
  // values only — no contact PII). Cheap, and it turns "it did nothing" into a readable answer.
  console.log('[event-registration-sync] payload', JSON.stringify({ via, parsed: { eventId: input.eventId, eventName: input.eventName, eventStart: input.eventStart }, shape: describePayloadShape(req.body) }));
  if (!input.contactId) {
    return res.status(400).json({ error: 'No contact id in the payload. Send {"contactId":"{{contact.id}}", "eventId": …, "eventName": …}, or call with ?echo=1 to see what GHL delivers.' });
  }

  const dryRun = req.query.dryRun === '1' || (req.body as any)?.dryRun === true;
  const noConversions = req.query.noConversions === '1';
  const work = () => ingestEventRegistration({ ...input, contactId: input.contactId! }, { dryRun, noConversions });

  if (wantsAsync(req)) {
    ackAndRun(res, work, { label: 'event-registration-sync', detail: { contactId: input.contactId, eventId: input.eventId, via } });
    return;
  }
  try {
    res.status(200).json({ ok: true, via, dryRun, ...(await work()) });
  } catch (error: any) {
    console.error('event-registration-sync error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to ingest event registration' });
  }
}
