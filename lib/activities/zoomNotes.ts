// lib/activities/zoomNotes.ts — write a Zoom AI Companion summary onto its GHL appointment.
//
// This runs BEFORE the appointment adapter in the nightly, per §2 of
// docs/sprints/zoom-notes-appointments.md: GHL stays the record a human can open, and the
// activity is ingested from an appointment that already carries its notes.
//
// SCOPE: notes only. Attendance (showed/noshow) is deliberately a separate pass, because a wrong
// `noshow` pushes the activity into NON_EVENT_STATUSES and SILENTLY DELETES a real,
// funder-reportable meeting from the grant count. A wrong note is a bad paragraph someone can
// see; a wrong noshow is a row that never appears. Notes cannot damage the count, so they ship
// first.
//
// THE NOOP CONTRACT, which is the whole reason this file has a ledger:
//   - the note id lives in zoom_appointment_notes, because Create APPENDS and a forgotten id
//     grows a second identical note on every run, forever
//   - the body hash lives beside it, because GHL does NOT no-op an unchanged write — a
//     byte-identical re-PUT still moved dateUpdated (measured 2026-09-10). Equal hash means send
//     NOTHING, not "send it again harmlessly"
// A write path that cannot report noop is broken.

import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, hasDatabase } from '../db';
import { zoomAppointmentNotes } from '../db/schema';
import { GhlClient, ghl } from '../ghl/client';
import { createAppointmentNote, listAppointmentNotes, updateAppointmentNote } from '../ghl/appointments';
import { flagForReview } from '../sync/reviewQueue';
import { ZoomClient, zoom } from '../zoom/client';
import { buildNoteBody, isEmptySummary, NOTE_MARKER } from '../zoom/noteBody';
import { getMeetingSummary, resolveOccurrence } from '../zoom/summaries';
import { GhlAppointment, zoomMeetingId } from './sources/appointment';

export type ZoomNoteOutcome =
  | 'created'
  | 'updated'
  | 'noop'
  | 'would-create'
  | 'would-update'
  | 'skipped';

export type ZoomNoteSkipReason =
  | 'no-zoom-id'
  | 'no-start-time'
  | 'not-yet-held'
  | 'no-occurrence'
  | 'no-summary'
  | 'empty-summary';

export interface ZoomNoteResult {
  appointmentId: string;
  outcome: ZoomNoteOutcome;
  reason?: ZoomNoteSkipReason;
  meetingNumber?: string;
  meetingUuid?: string;
  noteId?: string;
  bodyChars?: number;
}

export interface ZoomNoteOptions {
  dryRun?: boolean;
  client?: GhlClient;
  zoomClient?: ZoomClient;
  now?: Date;
}

interface LedgerRow {
  noteId: string;
  bodyHash: string;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

async function readLedger(appointmentId: string): Promise<LedgerRow | null> {
  if (!hasDatabase) return null;
  try {
    const [row] = await getDb()
      .select({ noteId: zoomAppointmentNotes.noteId, bodyHash: zoomAppointmentNotes.bodyHash })
      .from(zoomAppointmentNotes)
      .where(eq(zoomAppointmentNotes.appointmentId, appointmentId))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

async function writeLedger(appointmentId: string, noteId: string, meetingUuid: string, bodyHash: string): Promise<void> {
  if (!hasDatabase) return;
  try {
    await getDb()
      .insert(zoomAppointmentNotes)
      .values({ appointmentId, noteId, meetingUuid, bodyHash })
      .onConflictDoUpdate({
        target: zoomAppointmentNotes.appointmentId,
        set: { noteId, meetingUuid, bodyHash, writtenAt: sql`now()` },
      });
  } catch {
    /* best-effort: the marker-scan fallback below still finds our note next run */
  }
}

/**
 * Find a note we previously wrote, when the ledger cannot help.
 *
 * Without this, a run on a machine with no DATABASE_URL — or an appointment written before the
 * ledger existed — would append a second note every single time. The marker is invisible in the
 * GHL UI and is what makes our note recognisable as ours.
 */
async function findOwnNote(appointmentId: string, client: GhlClient): Promise<{ id: string; body: string } | null> {
  try {
    const notes = await listAppointmentNotes(appointmentId, client);
    const mine = notes.find((n) => n.body.includes(NOTE_MARKER));
    return mine ? { id: mine.id, body: mine.body } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve one appointment's Zoom summary and write it as a note.
 *
 * Every early return is a NAMED skip rather than a silent nothing, because "we chose not to" and
 * "it quietly failed" have to be distinguishable in the run report.
 */
export async function syncZoomNote(
  appointment: GhlAppointment,
  opts: ZoomNoteOptions = {},
): Promise<ZoomNoteResult> {
  const client = opts.client ?? ghl();
  const zc = opts.zoomClient ?? zoom();
  const now = opts.now ?? new Date();
  const base = { appointmentId: appointment.id };

  const meetingNumber = zoomMeetingId(appointment.address);
  if (!meetingNumber) return { ...base, outcome: 'skipped', reason: 'no-zoom-id' };
  if (!appointment.startTime) return { ...base, outcome: 'skipped', reason: 'no-start-time', meetingNumber };

  const start = new Date(appointment.startTime);
  if (Number.isNaN(start.getTime())) return { ...base, outcome: 'skipped', reason: 'no-start-time', meetingNumber };
  if (start.getTime() > now.getTime()) return { ...base, outcome: 'skipped', reason: 'not-yet-held', meetingNumber };

  const occurrence = await resolveOccurrence(meetingNumber, start, zc);
  if (!occurrence) {
    // NO EVIDENCE, which is not the same as evidence of absence: the meeting may have moved to a
    // phone call, run in person, or used someone's personal room. We write nothing and surface it
    // for a human. subjectId is set deliberately — sync_review's unique index is
    // (kind, record_id, subject_id) and Postgres treats NULLs as distinct, so leaving it unset
    // would insert a fresh row every night instead of bumping seen_count.
    await flagForReview({
      kind: 'zoom-no-occurrence',
      objectType: 'appointment',
      recordId: appointment.id,
      recordLabel: appointment.title,
      subjectType: 'zoom-meeting',
      subjectId: meetingNumber,
      reason: 'No Zoom occurrence found for this appointment’s meeting id and start time',
      detail: { startTime: appointment.startTime, address: appointment.address },
    });
    return { ...base, outcome: 'skipped', reason: 'no-occurrence', meetingNumber };
  }

  const summary = await getMeetingSummary(occurrence.uuid, zc);
  if (!summary) {
    return { ...base, outcome: 'skipped', reason: 'no-summary', meetingNumber, meetingUuid: occurrence.uuid };
  }
  if (isEmptySummary(summary)) {
    return { ...base, outcome: 'skipped', reason: 'empty-summary', meetingNumber, meetingUuid: occurrence.uuid };
  }

  const body = buildNoteBody(summary);
  const bodyHash = hash(body);
  const common = { ...base, meetingNumber, meetingUuid: occurrence.uuid, bodyChars: body.length };

  const ledger = await readLedger(appointment.id);
  let noteId = ledger?.noteId;
  let knownHash = ledger?.bodyHash;

  if (!noteId) {
    const existing = await findOwnNote(appointment.id, client);
    if (existing) {
      noteId = existing.id;
      knownHash = hash(existing.body);
    }
  }

  // The diff. GHL will happily accept an identical body and bump dateUpdated; we decline to ask.
  if (noteId && knownHash === bodyHash) {
    return { ...common, outcome: 'noop', noteId };
  }

  if (opts.dryRun) {
    return { ...common, outcome: noteId ? 'would-update' : 'would-create', noteId };
  }

  const userId = appointment.assignedUserId;
  const written = noteId
    ? await updateAppointmentNote(appointment.id, noteId, body, userId, client)
    : await createAppointmentNote(appointment.id, body, userId, client);

  await writeLedger(appointment.id, written.id, occurrence.uuid, bodyHash);

  return { ...common, outcome: noteId ? 'updated' : 'created', noteId: written.id };
}
