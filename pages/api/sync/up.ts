// pages/api/sync/up.ts — real-time UP-sync webhook.
//
// GHL "Contact Changed" workflow -> Webhook action POSTs { contactId } here. We push the
// contact's mapped fields UP to its company (equality-guarded); if the company actually
// changed, we fan the new state DOWN to the company's other contacts (roster from the
// associations graph). Both directions are equality-guarded, so it's idempotent and can't
// ping-pong.
//
// Auth: shared secret in the `x-webhook-secret` header (or `?secret=`), compared to
// SYNC_WEBHOOK_SECRET. Configure the GHL webhook body as e.g. { "contactId": "{{contact.id}}" }.
// Add `?dryRun=1` to preview writes without applying.
//
// RESPONDS 202 IMMEDIATELY and finishes the work in the background (2026-08-18). This handler does a
// lot per contact change and measured 7.4–17.7s end to end — far beyond GHL's webhook timeout, so
// every contact change logged a FAILURE, hundreds piled up, and GHL flagged the workflow "Needs
// Review" and stopped running it. Real-time sync had silently stopped. See lib/webhooks/fastAck.ts.
// `?dryRun=1` and `?sync=1` still run synchronously and return the full result.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getCatalogs } from '@/lib/ghl/catalogCache';
import { applyContactChange } from '@/lib/sync/orchestrate';
import { enrichCompany, defaultEnrichers } from '@/lib/enrichment';
import { runStageScoreTrigger } from '@/lib/stage/trigger';
import { readRecordFields } from '@/lib/ghl/records';
import { getEnricherState, setEnricherState, normalizeCompanyAddress, addressNeedsGeocode, isGeocodableAddress } from '@/lib/enrichment/stateStore';
import { hasDatabase } from '@/lib/db';
import { hasWix } from '@/lib/wix/config';
import { runContactTeamPipeline } from '@/lib/wix-sync/pipeline';
import { withRun, newRunId } from '@/lib/audit/context';
import { ackAndRun, wantsAsync } from '@/lib/webhooks/fastAck';

function extractContactId(req: NextApiRequest): string | undefined {
  const b: any = req.body ?? {};
  return (
    b.contactId || b.contact_id || b.id ||
    b.contact?.id ||
    (req.query.contactId as string) || (req.query.contact_id as string)
  );
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = process.env.SYNC_WEBHOOK_SECRET;
  const provided = (req.headers['x-webhook-secret'] as string) || (req.query.secret as string);
  if (!secret || provided !== secret) return res.status(401).json({ error: 'unauthorized' });

  const contactId = extractContactId(req);
  if (!contactId) return res.status(400).json({ error: 'contactId required' });
  const dryRun = req.query.dryRun === '1' || (req.body && req.body.dryRun === true);

  // Tag every change this webhook fans out (sync/enrich/score across GHL + Wix) with one run id, so
  // the change log can show the whole cascade as a single traceable event.
  const runWork = async () =>
    withRun({ runId: newRunId(), trigger: `webhook:contact-changed${dryRun ? ':dryrun' : ''}` }, async () => {
  try {
    const catalogs = await getCatalogs();

    // Contact changed → push UP to its primary company; if the company changed, fan OUT down to all
    // its contacts. Equality-guarded end to end, so it's idempotent and can't ping-pong.
    const r = await applyContactChange(String(contactId), { apply: !dryRun });
    const companyId = r.companyId;
    const companyFieldsWritten = r.companyFieldsWritten;
    const fwd = r.up.forward[0];
    const upResp: Record<string, unknown> = { written: companyFieldsWritten, unchanged: fwd?.unchanged ?? 0, drift: fwd?.changes ?? [], skipped: fwd?.skipped ?? [], note: r.up.note };
    const downResp: Record<string, unknown> | null = r.down
      ? {
          contacts: r.down.counterpartCount,
          contactsChanged: r.down.forward.filter((f) => (dryRun ? f.changes.length : f.written.length) > 0).length,
          fieldsWritten: r.down.forward.reduce((n, f) => n + (dryRun ? f.changes.length : f.written.length), 0),
        }
      : null;

    // Real-time enrichment of the touched company. Gated on the company's STATE (not the app's
    // up-sync diff, which is empty when GHL native sync populated the company first): address-
    // independent enrichers (NAICS) always run and self-gate cheaply; address-dependent ones
    // (county, geo-zone) run only when the address is new/changed vs. what we last geocoded — so
    // they fill on create and refresh on a real address edit, not on every unrelated change.
    // Non-fatal: enrichment failures must never break the sync.
    let geocodeAddress: string | null = null;
    let runGeo = false;
    if (companyId) {
      try {
        const brf = await readRecordFields('business', companyId);
        geocodeAddress = normalizeCompanyAddress(brf.get);
        const state = await getEnricherState(companyId);
        // Two conditions, and both matter. `addressNeedsGeocode` asks "has it changed since we last
        // geocoded"; `isGeocodableAddress` asks "could this ever resolve at all". Without the second,
        // a company whose only address data is "MI" is attempted on every single delivery and can
        // never succeed — which, now that the state is only stamped on success, would be a permanent
        // retry instead of a permanent failure.
        runGeo = isGeocodableAddress(brf.get) && addressNeedsGeocode(geocodeAddress, state?.geocodedAddress);
      } catch { /* if we can't read state, fall back to non-address enrichers only */ }
    }
    const enrichers = runGeo ? defaultEnrichers : defaultEnrichers.filter((e) => !e.addressDependent);
    let enrich: { applied: number; skipped: number; fields: string[]; ranGeo: boolean } | { error: string } | null = null;
    if (companyId && enrichers.length) {
      try {
        const r = await enrichCompany(
          companyId,
          enrichers,
          catalogs.business,
          { mode: 'overwrite', minConfidence: 0.7 },
          { apply: !dryRun },
        );
        enrich = { applied: r.applied.length, skipped: r.skipped.length, fields: r.applied.map((a) => a.businessKey), ranGeo: runGeo };
        // Remember the address county/geo just ran on, so they don't re-geocode until it changes.
        //
        // 🔴 ONLY IF THE GEOCODE ACTUALLY PRODUCED SOMETHING. This used to stamp the state whenever
        // geo was ATTEMPTED, which turned any transient failure into a permanent one: the address is
        // marked "already geocoded", `addressNeedsGeocode` returns false from then on, and the
        // company keeps a blank county and geo_disadvantaged forever. Found on "Wayne"
        // (6aa1b1bf860f0045961d1bca, 2026-09-09): state held
        // geocodedAddress="1722 littlestone rd|grosse pointe woods|michigan|48236" while county and
        // geo_disadvantaged were both blank — a Michigan address in Wayne County that the app had
        // permanently given up on. Both are grant-eligibility dimensions (SBSH gates on county), so a
        // silent blank is a wrong answer, not a missing one.
        //
        // The test is the OUTCOME on the record, not the return value: a geocode that succeeds leaves
        // county or geo_disadvantaged populated — including the legitimate out-of-Michigan case,
        // where geo_disadvantaged is the string "None" rather than empty. Nothing populated means
        // the lookup did not land, so the state is left alone and the next delivery retries.
        if (!dryRun && runGeo && geocodeAddress) {
          const after = await readRecordFields('business', companyId);
          const landed = ['county', 'geo_disadvantaged'].some((k) => {
            const v = after.get(k);
            return v != null && v !== '';
          });
          if (landed) await setEnricherState(companyId, { geocodedAddress: geocodeAddress });
        }
      } catch (e: any) {
        enrich = { error: e?.message ?? 'enrichment failed' };
      }
    }

    // Client Stage scorer: (re)score the company and upsert today's Client Stage Tracking record.
    // Safe to call on every webhook — it gates on the company's STATE (scores on create / when the
    // scoring-input fingerprint changed; skips an unchanged re-fire with NO Claude call). Company-
    // scoped but triggered by the contact change. Non-fatal + isolated like the enrichers above.
    let stageScore: unknown = null;
    if (companyId) {
      try {
        stageScore = await runStageScoreTrigger(companyId, { apply: !dryRun, businessCatalog: catalogs.business });
      } catch (e: any) {
        stageScore = { error: e?.message ?? 'stage scoring failed' };
      }
    }

    // Contact → Team pipeline: readiness enrich (on status=Approved) + Wix Team sync. This makes
    // ONE "Contact Changed" webhook fan out to everything. Non-fatal + isolated: any failure here
    // must never break the company up/down sync above, so it's wrapped and only runs when the DB +
    // Wix are configured. (The same pipeline is also exposed standalone at /api/wix-sync.)
    let readiness: unknown = null;
    if (hasDatabase && hasWix) {
      try {
        readiness = await runContactTeamPipeline(String(contactId), catalogs.contact, { apply: !dryRun });
      } catch (e: any) {
        readiness = { error: e?.message ?? 'readiness/Wix pipeline failed' };
      }
    }

    return { ok: true, dryRun, contactId, companyId, up: upResp, down: downResp, enrich, stageScore, readiness };
  } catch (e: any) {
    console.error('sync/up error:', e);
    // Rethrow so the caller decides how to surface it: a synchronous request gets a 500, an
    // already-acknowledged async run gets it logged (it cannot un-send the 202).
    throw e;
  }
    });

  // A human/script asking for the result waits for it; a GHL webhook must not.
  if (!wantsAsync(req)) {
    try {
      return res.status(200).json(await runWork());
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? 'sync failed' });
    }
  }

  ackAndRun(res, runWork, { label: 'sync/up', detail: { contactId, dryRun } });
  return;
}
