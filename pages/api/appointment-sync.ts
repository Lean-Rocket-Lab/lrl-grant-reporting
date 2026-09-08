// pages/api/appointment-sync.ts — GHL appointment → Intake / Technical Assistance activity.
//
// Wire a GHL workflow on the Appointment trigger (booked / status changed / rescheduled) with a
// Custom Webhook action:
//     POST https://lrl-grant-reporting.vercel.app/api/appointment-sync
//     { "appointmentId": "{{appointment.id}}" }
// Auth: shared secret in `x-webhook-secret` (or `?secret=`) vs WIX_SYNC_WEBHOOK_SECRET.
// `?dryRun=1` previews without writing · `?sync=1` waits and returns the full result ·
// `?echo=1` dumps exactly what GHL delivered and runs nothing (how the resource trigger's payload
// shape was worked out when the documented merge field turned out not to exist).
//
// Re-delivery is SAFE and expected: the appointment id is the idempotency key, so booking, then
// rescheduling, then a status change all converge on ONE activity record. That is what makes it
// acceptable to fire this webhook on every appointment event.

import type { NextApiRequest, NextApiResponse } from 'next';
import { ackAndRun, wantsAsync } from '@/lib/webhooks/fastAck';
import { ingestAppointmentById } from '@/lib/activities/sources/appointment';

const GHL_ID = /^[A-Za-z0-9]{15,30}$/;

/** The appointment id, from the explicit places first, then by a shallow scan of the payload. */
function extractAppointmentId(req: NextApiRequest): { id?: string; via?: string } {
  const q = req.query.appointmentId ?? req.query.id;
  if (typeof q === 'string' && q) return { id: q, via: 'query' };
  const body = (req.body ?? {}) as Record<string, any>;
  for (const key of ['appointmentId', 'appointment_id', 'id', 'recordId']) {
    const v = body[key];
    if (typeof v === 'string' && GHL_ID.test(v)) return { id: v, via: `body.${key}` };
  }
  // GHL nests the appointment under different keys depending on the trigger.
  for (const container of ['appointment', 'calendar', 'event']) {
    const v = body[container]?.id;
    if (typeof v === 'string' && GHL_ID.test(v)) return { id: v, via: `body.${container}.id` };
  }
  return {};
}

function authorized(req: NextApiRequest): boolean {
  const expected = process.env.WIX_SYNC_WEBHOOK_SECRET;
  if (!expected) {
    // Fail CLOSED in production. An unset secret used to mean "open", which is a fine dev
    // convenience and a hole on a public deployment: one missing Vercel env var silently turns a
    // live webhook receiver into an anonymous write endpoint. Dev keeps the convenience.
    return process.env.NODE_ENV !== 'production';
  }
  const got = req.headers['x-webhook-secret'] ?? req.query.secret;
  return typeof got === 'string' && got === expected;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  // NOTE: echo runs AFTER auth, deliberately. It used to run first, which made `?echo=1` an
  // unauthenticated endpoint on a public deployment (found 2026-09-08 re-probing after the
  // middleware deploy). It reflects only the caller's own body, so nothing of ours leaked — but a
  // diagnostic that sits in front of the auth check is one edit away from leaking something real.
  // Debugging still works: send the same x-webhook-secret the GHL workflow sends.
  if (req.query.echo === '1') {
    return res.status(200).json({ echo: true, query: req.query, body: req.body, headers: { 'content-type': req.headers['content-type'] } });
  }

  const { id, via } = extractAppointmentId(req);
  if (!id) {
    return res.status(400).json({ error: 'No appointment id in the payload. Send {"appointmentId":"{{appointment.id}}"}, or call with ?echo=1 to see what GHL is delivering.' });
  }

  const dryRun = req.query.dryRun === '1' || (req.body as any)?.dryRun === true;
  const work = () => ingestAppointmentById(id, { dryRun });

  if (wantsAsync(req)) {
    ackAndRun(res, work, { label: 'appointment-sync', detail: { appointmentId: id, via } });
    return;
  }

  try {
    const result = await work();
    res.status(200).json({ ok: true, via, dryRun, ...result });
  } catch (error: any) {
    console.error('appointment-sync error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to ingest appointment' });
  }
}
