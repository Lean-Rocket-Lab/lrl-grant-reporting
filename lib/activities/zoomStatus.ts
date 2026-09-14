// lib/activities/zoomStatus.ts — set a GHL appointment's status from Zoom attendance evidence.
//
// Build-order step 4 (docs/sprints/zoom-notes-appointments.md §6). It runs in the same pass as the
// note writer and reuses the occurrence that pass already resolved.
//
// ── WHY THIS DOES NOT IMPLEMENT §2's TABLE AS WRITTEN ──────────────────────────────────────────
//
// §2 says: occurrence + any non-host attendee → `showed`; occurrence + host only → `noshow`. That
// rule was run READ-ONLY against all 86 Zoom-linked appointments in the trailing 180 days on
// 2026-09-14, before a line of this file was written, and it would have made four kinds of bad
// write. Every one is a measurement, not a worry:
//
//   1. THE ONE GENUINE `confirmed -> noshow` WAS WRONG, IN THE DIRECTION THAT DELETES DATA.
//      Chad Petosky, 2026-09-02: participants list Alex alone — but that meeting has a 1,915-char
//      AI summary of a real conversation. The client joined by phone, or in some way the
//      participant record missed. §2 would have written `noshow`, NON_EVENT_STATUSES would have
//      dropped it, and a funder-reportable intake would have left the grant count silently.
//      1 of 1 genuine no-show candidates was a false positive.
//   2. IT OVERWRITES WHAT A HUMAN RECORDED. 17 of 18 `noshow` writes (and 1 `showed`) landed on
//      appointments a person had already marked `cancelled` — replacing someone's record of WHY a
//      meeting did not happen with a machine's guess. Reporting-neutral, still not ours to erase.
//   3. AI NOTETAKER BOTS COUNT AS CLIENTS. Mohamed Hagras, 2026-05-05: the only participant in the
//      room is "Brandon's Notetaker" — no LRL human, no client — and §2's rule says `showed`.
//   4. `user_email` IS ALMOST ALWAYS EMPTY, so "external" cannot be read off the payload. §1b
//      flagged this for SOME guests; measured, it is nearly all of them, and staff who join
//      without signing in land on the external side ("BrandonBartel" and "Brandon Bartel" counted
//      as two external attendees on one meeting).
//
// So: the participants endpoint reliably answers "did anyone besides the host join". It does NOT
// reliably answer "did the CLIENT join" — which is the question the status field is asked to hold.
//
// THE RULE THIS FILE IMPLEMENTS. An earlier draft of it never wrote `noshow` at all, on the
// asymmetry that a wrong `showed` is a row someone can spot while a wrong `noshow` is a row that
// never appears. Zach overruled that on 2026-09-14 — a review queue nobody drains leaves every
// unmarked no-show counted as a held meeting, which is the over-count this feature exists to fix.
// Two things make that a smaller risk than the brief's "silently deletes" framing suggests:
// `noshow` makes the adapter SKIP ingestion (appointment.ts:115), it does not delete an activity
// that already exists; and a review row is still filed for every `noshow`, so the worklist exists
// without the write waiting on someone reading it.
//
//   already cancelled / noshow          → never touch (human-set)
//   no Zoom occurrence                  → leave alone (§2 row 3, unchanged — the safety rule)
//   a real summary OR a client present  → `showed`
//   an occurrence and neither of those  → `noshow`, AND a review row to correct from later
//
// GHL does not no-op an unchanged status — a byte-identical re-PUT moved `dateUpdated` (§4b) — so
// the current status is diffed before every write, and an appointment already `showed` costs zero
// HTTP calls.

import { GhlClient, ghl } from '../ghl/client';
import { setAppointmentStatus } from '../ghl/appointments';
import { flagForReview } from '../sync/reviewQueue';
import { ZoomClient, zoom } from '../zoom/client';
import { listPastParticipants, resolveOccurrence, getMeetingSummary, type ZoomParticipant } from '../zoom/summaries';
import { isEmptySummary } from '../zoom/noteBody';
import { GhlAppointment, NON_EVENT_STATUSES, zoomMeetingId } from './sources/appointment';

/** Meeting-assistant bots that join as participants. Their presence is not a client's presence. */
export const BOT_NAME_PATTERNS = [
  /notetaker/i,
  /note ?taker/i,
  /\botter\b/i,
  /fireflies/i,
  /fathom/i,
  /read\.?ai/i,
  /zoom ai/i,
  /companion/i,
  /\bbot\b/i,
  /recording/i,
];

const LRL_EMAIL = /@leanrocketlab\.org$/i;

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

export function isBot(p: ZoomParticipant): boolean {
  return BOT_NAME_PATTERNS.some((re) => re.test(p.name));
}

/**
 * Is this participant evidence that the CLIENT was in the room?
 *
 * Deliberately conservative on both sides. An LRL address is staff. A bot is nobody. A name that
 * matches the host is the host under a second device. Everything else counts — including the many
 * participants with no email at all, because externals are exactly who lack one.
 */
export function isClientSide(
  p: ZoomParticipant,
  opts: { hostName?: string; staffNames?: string[] } = {},
): boolean {
  if (LRL_EMAIL.test(p.email)) return false;
  if (isBot(p)) return false;
  const n = norm(p.name);
  if (!n) return false;
  if (opts.hostName && n === norm(opts.hostName)) return false;
  if ((opts.staffNames ?? []).some((s) => norm(s) === n)) return false;
  return true;
}

export type StatusAction = 'write' | 'leave';

export type StatusLeaveReason = 'human-set' | 'no-occurrence' | 'already-correct' | 'not-yet-held' | 'no-zoom-id';
export type StatusWriteReason = 'client-present' | 'summary-exists' | 'host-only-no-summary' | 'no-participants';

export interface StatusDecision {
  action: StatusAction;
  status?: 'showed' | 'noshow';
  reason: StatusLeaveReason | StatusWriteReason;
  /** The participants that counted as client-side, for the run report and the review row. */
  clientNames?: string[];
}

export interface AttendanceEvidence {
  currentStatus?: string;
  hasOccurrence: boolean;
  /** A summary that carries real content — an empty one is no evidence either way. */
  hasSummary: boolean;
  participants: ZoomParticipant[];
  hostName?: string;
  staffNames?: string[];
}

/**
 * The whole rule, as a pure function — no clients, no IO, so every branch above is unit-testable
 * against the real cases that motivated it.
 */
export function decideAppointmentStatus(ev: AttendanceEvidence): StatusDecision {
  const current = String(ev.currentStatus ?? '').toLowerCase();

  // A human already said this meeting did not happen. They know something the API does not, and
  // `cancelled` carries WHY. Never trade that for a guess.
  if (NON_EVENT_STATUSES.has(current)) return { action: 'leave', reason: 'human-set' };

  // §2 row 3, unsoftened: no occurrence can mean no-show, or a phone call, or an in-person
  // meeting, or someone's personal room. Absence of evidence is not evidence of absence, and
  // unlike every case below there is no Zoom record here to review later against.
  if (!ev.hasOccurrence) return { action: 'leave', reason: 'no-occurrence' };

  const clients = ev.participants.filter((p) => isClientSide(p, { hostName: ev.hostName, staffNames: ev.staffNames }));

  // EITHER kind of positive evidence is enough, and the two catch different failures.
  //
  //   A summary proves the meeting RAN even when the participant list does not show the client —
  //   Chad Petosky 2026-09-02 has a 1,915-char summary of a real conversation with Alex listed
  //   alone, because the client dialled in by phone. Zach's call, 2026-09-14: "if there is ever a
  //   real meeting summary that tells us a meeting happened, even if another participant didn't
  //   show up on zoom, we should mark it as showed."
  //
  //   A client in the participant list proves it just as well when AI Companion was off and no
  //   summary exists. 17 of 86 appointments have an occurrence and an empty summary; marking those
  //   `noshow` on the absence of a summary alone would contradict a participant record showing the
  //   client in the room. Summary-absence means the AI did not write, not that nobody came.
  if (ev.hasSummary || clients.length) {
    const names = clients.map((p) => p.name);
    const reason = ev.hasSummary ? (clients.length ? 'client-present' : 'summary-exists') : 'client-present';
    if (current === 'showed') return { action: 'leave', reason: 'already-correct', clientNames: names };
    return { action: 'write', status: 'showed', reason, clientNames: names };
  }

  // An occurrence, no summary, and nobody in the room but the host, staff or a notetaker bot.
  // §2 wrote `noshow` here; an earlier draft of this file queued it for a human instead. Zach
  // overruled that on 2026-09-14 and the reasoning is operational, not technical: "I would prefer
  // to review and update later rather than have a queue that don't get set until the team jumps in
  // manually." A queue nobody drains leaves every one of these counted as a held meeting, which is
  // the over-count this feature exists to fix. So it writes — AND still files a review row, so the
  // list to correct from exists without gating the write on someone reading it.
  if (current === 'noshow') return { action: 'leave', reason: 'already-correct' };
  return { action: 'write', status: 'noshow', reason: ev.participants.length ? 'host-only-no-summary' : 'no-participants' };
}

export type ZoomStatusOutcome = 'updated' | 'would-update' | 'noop' | 'leave';

export interface ZoomStatusResult {
  appointmentId: string;
  outcome: ZoomStatusOutcome;
  reason: string;
  from?: string;
  to?: string;
  clientNames?: string[];
  meetingUuid?: string;
}

export interface ZoomStatusOptions {
  dryRun?: boolean;
  client?: GhlClient;
  zoomClient?: ZoomClient;
  now?: Date;
  staffNames?: string[];
  /**
   * What the note pass already resolved for this appointment. Passing it avoids re-walking
   * past_instances and the summary for every appointment — the note writer has just done both.
   * Omit it and this resolves everything itself (used by --appointment and by tests).
   */
  resolved?: { meetingUuid: string | null; hasSummary: boolean };
}

/** Resolve attendance for one appointment and set its status, per `decideAppointmentStatus`. */
export async function syncZoomStatus(
  appointment: GhlAppointment,
  opts: ZoomStatusOptions = {},
): Promise<ZoomStatusResult> {
  const client = opts.client ?? ghl();
  const zc = opts.zoomClient ?? zoom();
  const now = opts.now ?? new Date();
  const base = { appointmentId: appointment.id };
  const current = appointment.appointmentStatus;

  // Cheap exits first, and note the ORDER: a human-set status wins even over a missing meeting id,
  // because "leave it alone" is the same answer and it costs no calls to say so.
  if (NON_EVENT_STATUSES.has(String(current ?? '').toLowerCase())) {
    return { ...base, outcome: 'leave', reason: 'human-set', from: current };
  }

  const meetingNumber = zoomMeetingId(appointment.address);
  if (!meetingNumber) return { ...base, outcome: 'leave', reason: 'no-zoom-id', from: current };
  if (!appointment.startTime) return { ...base, outcome: 'leave', reason: 'no-start-time', from: current };

  const start = new Date(appointment.startTime);
  if (Number.isNaN(start.getTime())) return { ...base, outcome: 'leave', reason: 'no-start-time', from: current };
  if (start.getTime() > now.getTime()) return { ...base, outcome: 'leave', reason: 'not-yet-held', from: current };

  let meetingUuid = opts.resolved?.meetingUuid ?? null;
  let hasSummary = opts.resolved?.hasSummary ?? false;
  if (!opts.resolved) {
    const occ = await resolveOccurrence(meetingNumber, start, zc);
    meetingUuid = occ?.uuid ?? null;
    if (meetingUuid) {
      const summary = await getMeetingSummary(meetingUuid, zc);
      hasSummary = !!summary && !isEmptySummary(summary);
    }
  }

  if (!meetingUuid) return { ...base, outcome: 'leave', reason: 'no-occurrence', from: current };

  const participants = await listPastParticipants(meetingUuid, zc);
  const decision = decideAppointmentStatus({
    currentStatus: current,
    hasOccurrence: true,
    hasSummary,
    participants,
    hostName: undefined,
    staffNames: opts.staffNames,
  });

  if (decision.action === 'leave') {
    return { ...base, outcome: decision.reason === 'already-correct' ? 'noop' : 'leave', reason: decision.reason, from: current, clientNames: decision.clientNames, meetingUuid };
  }

  const common = { ...base, reason: decision.reason, from: current, to: decision.status, clientNames: decision.clientNames, meetingUuid };
  if (opts.dryRun) return { ...common, outcome: 'would-update' };

  await setAppointmentStatus(appointment.id, decision.status!, client);

  // Every `noshow` files its own review row. The status is set either way — that was the point of
  // overruling the queue — but `noshow` is the direction that keeps an activity from ever being
  // ingested, so the list to correct from has to exist. subjectId is the meeting number so the
  // unique index bumps seen_count instead of inserting a fresh row every night.
  if (decision.status === 'noshow') {
    await flagForReview({
      kind: 'zoom-attendance-noshow',
      objectType: 'appointment',
      recordId: appointment.id,
      recordLabel: appointment.title,
      subjectType: 'zoom-meeting',
      subjectId: meetingNumber,
      reason:
        decision.reason === 'no-participants'
          ? 'Marked noshow: a Zoom occurrence exists but returned no participants and no summary'
          : 'Marked noshow: only the host, LRL staff or a notetaker bot appeared, and no summary was written',
      detail: {
        startTime: appointment.startTime,
        previousStatus: current,
        participants: participants.map((p) => ({ name: p.name, email: p.email || null })),
      },
    });
  }

  return { ...common, outcome: 'updated' };
}
