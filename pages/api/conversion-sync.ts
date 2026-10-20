// pages/api/conversion-sync.ts — a GHL form submission or appointment booking → server-side
// conversions to GA4, LinkedIn and Meta. See lib/conversions/site.ts for the why and the modes.
//
// Wire TWO workflows, both with a Webhook action to this URL and the same header as the others:
//     POST https://lrl-grant-reporting.vercel.app/api/conversion-sync?type=form_submitted
//       trigger  Form Submitted            Custom Data  formName: {{form.name}}   (optional)
//     POST https://lrl-grant-reporting.vercel.app/api/conversion-sync?type=meeting_booked
//       trigger  Customer Booked Appointment   Custom Data  appointmentId: {{appointment.id}}  (REQUIRED)
//     header   x-webhook-secret: <WIX_SYNC_WEBHOOK_SECRET>
// GHL sends its standard payload (contact_id at top level, Custom Data under `customData`).
// `?echo=1` dumps what GHL delivered (behind auth). `?dryRun=1` plans/validates and records nothing.
// `?sync=1` waits for the result. The type may also come as `customData.type` or `body.type`.

import type { NextApiRequest, NextApiResponse } from 'next';
import { ackAndRun, wantsAsync } from '@/lib/webhooks/fastAck';
import { extractConversionPayload, reportSiteConversion, type SiteConversionInput } from '@/lib/conversions/site';

function authorized(req: NextApiRequest): boolean {
  const expected = process.env.WIX_SYNC_WEBHOOK_SECRET;
  // Fail CLOSED in production — same rule and same secret as the other GHL webhook receivers.
  if (!expected) return process.env.NODE_ENV !== 'production';
  const got = req.headers['x-webhook-secret'] ?? req.query.secret;
  return typeof got === 'string' && got === expected;
}

/** Key names at the top two levels, plus the values of keys that look like form/survey/appointment/workflow ids or names. */
export function describeConversionPayload(body: any, query: Record<string, unknown>) {
  const b = body && typeof body === 'object' ? body : {};
  const interesting: Record<string, unknown> = {};
  const walk = (o: any, prefix: string, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 2) return;
    for (const [k, v] of Object.entries(o)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (/^(triggerData|workflow|customData)$/.test(k) && v && typeof v === 'object') {
        // The trigger's own block: show it whole (ids/names only — it does not carry contact values).
        interesting[path] = JSON.stringify(v).slice(0, 1500);
      } else if (/^[a-z][a-z0-9_]*$/i.test(k) && /form|survey|appointment|calendar|submission/i.test(k) && !/date|time/i.test(k)) {
        interesting[path] = v && typeof v === 'object' ? (Array.isArray(v) ? `[array ${v.length}]` : Object.keys(v)) : v;
      } else if (v && typeof v === 'object' && /^[a-z][a-z0-9_]*$/i.test(k)) walk(v, path, depth + 1);
    }
  };
  walk(b, '', 0);
  // GHL's standard payload carries EVERY custom field in the account as a top-level key, labelled
  // by its display name ("Expense Vendor (item 10)" …) — hundreds of them. Keep the machine-named
  // keys (contact_id, form_id, …), which is where a form/submission id would be, and count the rest.
  const all = Object.keys(b);
  const machine = all.filter((k) => /^[a-z][a-z0-9_.]*$/i.test(k) && !/\s/.test(k));
  return { type: query.type ?? null, echo: query.echo === '1', interesting, customDataKeys: Object.keys(b.customData ?? {}), machineKeys: machine, otherKeyCount: all.length - machine.length };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  // Payload shape on EVERY delivery (echo included): key names + form/survey/appointment-ish values,
  // never contact values. GHL's trigger payloads are undocumented; this is how they get read.
  console.log('[conversion-sync] payload', JSON.stringify(describeConversionPayload(req.body, req.query)));
  if (req.query.echo === '1') return res.status(200).json({ echo: true, query: req.query, body: req.body });

  const { via, ...input } = extractConversionPayload(req.body, req.query as Record<string, unknown>);
  if (!input.type) return res.status(400).json({ error: `Missing or unknown type. Call ?type=form_submitted or ?type=meeting_booked (got ${JSON.stringify(req.query.type ?? null)}).` });
  if (!input.contactId) return res.status(400).json({ error: 'No contact id in the payload. GHL sends contact_id at top level; or call with ?echo=1 to see what arrived.' });
  if (input.type === 'meeting_booked' && !input.appointmentId) {
    console.warn('[conversion-sync] meeting_booked without appointmentId', JSON.stringify({ keys: Object.keys(req.body ?? {}), customData: Object.keys((req.body as any)?.customData ?? {}) }));
  }

  const dryRun = req.query.dryRun === '1' || (req.body as any)?.dryRun === true;
  const full: SiteConversionInput = { ...(input as SiteConversionInput), contactId: input.contactId, type: input.type };
  const work = () => reportSiteConversion(full, { dryRun });

  if (wantsAsync(req)) {
    ackAndRun(res, work, { label: 'conversion-sync', detail: { type: input.type, contactId: input.contactId, via } });
    return;
  }
  try {
    res.status(200).json({ ok: true, via, dryRun, ...(await work()) });
  } catch (error: any) {
    console.error('conversion-sync error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to report conversion' });
  }
}
