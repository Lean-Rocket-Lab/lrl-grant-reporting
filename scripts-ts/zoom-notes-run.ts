// scripts-ts/zoom-notes-run.ts — write Zoom AI Companion summaries onto their GHL appointments.
//
// Runs BEFORE appointment-ingest-run.ts in the nightly (see §2 of the brief): notes land on the
// appointment first, so the activity is ingested from a record that already carries them.
//
// Dry-run by default (house rule: dry-run → review → apply).
//   npx vite-node scripts-ts/zoom-notes-run.ts --days 7
//   npx vite-node scripts-ts/zoom-notes-run.ts --days 7 --apply
//   npx vite-node scripts-ts/zoom-notes-run.ts --from 2026-08-01 --to 2026-09-10 --apply
//   npx vite-node scripts-ts/zoom-notes-run.ts --appointment <id> --apply   # one record
//
// Two writes per appointment, in this order: the NOTE, then the STATUS. A real summary OR a
// client-side participant means `showed`; an occurrence with neither means `noshow`, and every
// `noshow` also files a sync_review row (kind=zoom-attendance-noshow) to correct from later. An
// appointment a human marked cancelled/noshow is never touched, and no Zoom occurrence at all
// leaves the status alone. See lib/activities/zoomStatus.ts. `--no-status` writes notes only.
//
// ── THE TWO SCOPES ARE DELIBERATELY DIFFERENT (Zach, 2026-09-18) ───────────────────────────────
//
//   NOTES   -> EVERY calendar with a Zoom link. "That way we get notes in the CRM but we don't
//              cause an issue for the reporting side." A note is a paragraph a human reads on an
//              appointment; it cannot enter a grant count, so there is nothing to protect.
//   STATUS  -> routed calendars ONLY, by default. `showed`/`noshow` is the field the appointment
//              adapter reads, so it stays where the reporting rules already are. `--status-all`
//              lifts that if it is ever wanted.
//
// 🔴 WHY THIS CANNOT LEAK INTO REPORTING, which is the thing actually worth checking: activity
// creation is NOT gated by which calendars this script reads. `ingestAppointment` resolves the
// route itself and returns `no-route` for any calendar without a rule (appointment.ts:105), and
// appointment-ingest-run.ts separately never even fetches an unrouted calendar. Two independent
// gates, neither of them here. Widening this script cannot create a single activity record.
//
// Only calendars WITH an appointment routing rule are read, for the same reason the ingest run
// does it: personal calendars carry vendor and partner calls that are deliberately out of scope,
// and a client's notes should not be written onto a meeting the grants never see.
//
// A clean night prints all `noop`. If it prints `updated` for appointments nobody touched, the
// hash guard is broken — that is the signal to look at, not a green exit code.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Local dev reads .env.local; in CI the secrets arrive as real env vars and the file does not
// exist — an unguarded readFileSync ENOENTs the whole run before it starts (cost two nightlies).
try {
  for (const l of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env.local (CI) — env is already populated */ }
if (!process.env.GHL_TARGET) process.env.GHL_TARGET = 'live';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const APPLY = process.argv.includes('--apply');
const NO_STATUS = process.argv.includes('--no-status');
// Restores the pre-2026-09-18 behaviour: notes only on calendars that have a routing rule.
const ROUTED_ONLY = process.argv.includes('--routed-only');
// Lets the status writer follow the notes onto unrouted calendars. Off by default on purpose.
const STATUS_ALL = process.argv.includes('--status-all');

(async () => {
  const { hasZoom } = await import('../lib/zoom/config');
  if (!hasZoom) {
    // Naming the missing thing beats a 401 three calls later. The Square preflight exists because
    // an ambiguous credential error cost four runs on 2026-09-01.
    console.error('Missing Zoom credentials. Need ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET');
    console.error('in .env.local locally, and in GitHub Actions secrets for the nightly.');
    process.exit(2);
  }

  const { ghl } = await import('../lib/ghl/client');
  const { zoom } = await import('../lib/zoom/client');
  const { listRoutes } = await import('../lib/activities/routes');
  const { listAppointments, getAppointment, APPOINTMENT_SOURCE, zoomMeetingId } = await import('../lib/activities/sources/appointment');
  const { syncZoomNote } = await import('../lib/activities/zoomNotes');
  const { syncZoomStatus } = await import('../lib/activities/zoomStatus');

  const c = ghl();
  const zc = zoom();

  const tally: Record<string, number> = {};
  const statusTally: Record<string, number> = {};
  const bumpStatus = (k: string) => { statusTally[k] = (statusTally[k] ?? 0) + 1; };
  const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  const noOccurrence: string[] = [];

  /** What the note pass already learned, so the status pass does not re-walk past_instances. */
  const resolvedFrom = (r: any) => ({
    meetingUuid: r.meetingUuid ?? null,
    hasSummary: !['empty-summary', 'no-summary'].includes(r.reason),
  });

  const runStatus = async (a: any, noteResult: any, calendarIsRouted = true) => {
    if (NO_STATUS) return;
    if (!calendarIsRouted && !STATUS_ALL) { bumpStatus('skip:unrouted-calendar'); return; }
    const s = await syncZoomStatus(a, {
      client: c,
      zoomClient: zc,
      dryRun: !APPLY,
      resolved: resolvedFrom(noteResult),
    });
    const key = s.outcome === 'leave' ? `leave:${s.reason}` : s.outcome === 'updated' || s.outcome === 'would-update' ? `${s.outcome}:${s.to}` : s.outcome;
    bumpStatus(key);
    if (s.outcome === 'updated' || s.outcome === 'would-update') {
      console.log(`    status ${s.outcome.padEnd(12)} ${String(a.title ?? '').slice(0, 40).padEnd(42)} ${s.from} -> ${s.to}  [${(s.clientNames ?? []).join(', ')}]`);
    }
    return s;
  };

  const report = (a: any, r: any) => {
    const key = r.outcome === 'skipped' ? `skip:${r.reason}` : r.outcome;
    bump(key);
    if (r.reason === 'no-occurrence') {
      noOccurrence.push(`  ${String(a.startTime ?? '').slice(0, 10)}  ${String(a.title ?? '').slice(0, 44)}  zoom=${r.meetingNumber}`);
    }
    if (['created', 'updated', 'would-create', 'would-update'].includes(r.outcome)) {
      console.log(`    ${r.outcome.padEnd(13)} ${String(a.title ?? '').slice(0, 40).padEnd(42)} ${r.bodyChars} chars`);
    }
  };

  const one = arg('--appointment');
  if (one) {
    const a = await getAppointment(one, c);
    if (!a) { console.error(`Appointment ${one} not found`); process.exit(1); }
    console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');
    const r = await syncZoomNote(a, { client: c, zoomClient: zc, dryRun: !APPLY });
    console.log(JSON.stringify(r, null, 2));
    const s = await runStatus(a, r);
    if (s) console.log(JSON.stringify(s, null, 2));
    process.exit(0);
  }

  const days = arg('--days');
  const to = arg('--to') ? new Date(arg('--to')!) : new Date();
  const from = arg('--from')
    ? new Date(arg('--from')!)
    : new Date(to.getTime() - (Number(days ?? 7) || 7) * 86400000);

  const routes = (await listRoutes({ force: true })).filter((r) => r.source === APPOINTMENT_SOURCE && r.enabled);
  // No routing rules is fatal only when the STATUS writer is the point. Notes do not need a rule
  // any more, so a location with none still gets its summaries written.
  if (!routes.length && (ROUTED_ONLY || (!NO_STATUS && !STATUS_ALL))) {
    console.log('No appointment routing rules configured — nothing to annotate.');
    process.exit(0);
  }

  const cals: any[] = (await c.request<any>({ path: '/calendars/', params: { locationId: c.locationId } })).calendars ?? [];
  const isRouted = (k: any) =>
    routes.some((r) => (r.matchKind === 'calendar' && r.matchId === k.id) || (r.matchKind === 'calendar_group' && r.matchId === k.groupId));
  const routed = cals.filter(isRouted);
  // Notes go everywhere by default; --routed-only restores the old, narrower sweep.
  const sweep = ROUTED_ONLY ? routed : cals;

  console.log(`target=${process.env.GHL_TARGET}  window=${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`);
  console.log(`notes on ${sweep.length}/${cals.length} calendars · status on ${STATUS_ALL ? sweep.length : routed.length} (routed: ${routed.length})`);
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

  for (const k of sweep) {
    const appts = await listAppointments(k.id, from.getTime(), to.getTime(), c);
    const withZoom = appts.filter((a) => zoomMeetingId(a.address));
    const routedHere = isRouted(k);
    // An unrouted calendar is worth naming rather than printing as if it were the same: its notes
    // are written, its statuses are not, and nothing on it becomes an activity.
    if (withZoom.length || routedHere) {
      console.log(
        `${String(k.name).slice(0, 44).padEnd(46)} ${String(withZoom.length).padStart(4)}/${String(appts.length).padStart(4)} with a Zoom link${routedHere ? '' : '   [notes only — no routing rule]'}`,
      );
    }
    for (const a of withZoom) {
      const r = await syncZoomNote(a, { client: c, zoomClient: zc, dryRun: !APPLY });
      report(a, r);
      await runStatus(a, r, routedHere);
      // Keep well under the 429 threshold (~0.12s spacing 429s; house rule is >=0.3s).
      await new Promise((res) => setTimeout(res, 320));
    }
  }

  console.log('\nNOTE OUTCOMES:', JSON.stringify(tally, null, 1));
  if (!NO_STATUS) console.log('STATUS OUTCOMES:', JSON.stringify(statusTally, null, 1));
  if (noOccurrence.length) {
    console.log(`\n⚠️  ${noOccurrence.length} appointment(s) had NO Zoom occurrence for their meeting id + start time.`);
    console.log('   Status was left alone and each is queued in sync_review (kind=zoom-no-occurrence).');
    console.log('   These are usually meetings that moved to a phone call, ran in person, or used a personal room:');
    for (const line of noOccurrence.slice(0, 25)) console.log(line);
    if (noOccurrence.length > 25) console.log(`   …and ${noOccurrence.length - 25} more`);
  }
  // "No writes made" was false: flagForReview sits ABOVE the dryRun check in zoomNotes.ts, so a dry
  // run still records its no-occurrence anomalies. They are deduped on (kind, record_id, subject_id)
  // so nothing churns, and surfacing them during a review is the point — but a runner that overstates
  // its own harmlessness is exactly the kind of claim this project does not tolerate elsewhere.
  if (!APPLY) {
    console.log('\nDRY RUN — no GHL writes made. Re-run with --apply to write.');
    if (noOccurrence.length) console.log(`(The ${noOccurrence.length} sync_review row(s) above ARE recorded, dry run or not.)`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
