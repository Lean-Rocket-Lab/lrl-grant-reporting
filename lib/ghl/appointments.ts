// lib/ghl/appointments.ts — the calendar-appointment surface: notes and appointment status.
//
// Everything here was probed against a throwaway appointment in the LRL sandbox on 2026-09-10 and
// the results are recorded in docs/sprints/zoom-notes-appointments.md §4b. Two behaviours matter
// more than the endpoint shapes:
//
//  1. `Update Note` edits IN PLACE — after a PUT the appointment holds exactly ONE note with the
//     new body and the original dateAdded. Create, by contrast, APPENDS. So idempotency depends
//     entirely on remembering the note id (see zoom_appointment_notes).
//  2. A partial PUT of an appointment does NOT clear omitted fields. Sending only
//     {appointmentStatus, toNotify:false} left title, startTime, endTime, address, calendarId,
//     contactId and assignedUserId untouched. The brief's fear here is retired — but it was
//     verified, not assumed, and it should be re-verified if GHL changes the endpoint.
//
// 🔴 What is NOT true: GHL does not no-op an unchanged write. A byte-identical re-PUT still moved
// `dateUpdated`. THE CALLER MUST DIFF. That is the writeRecordFields lesson on a new endpoint.

import { GhlClient, ghl } from './client';

export interface AppointmentNote {
  id: string;
  body: string;
  contactId?: string;
  createdBy?: { id?: string; name?: string };
  dateAdded?: string;
}

/**
 * Notes on an appointment, newest page first.
 *
 * Note the `autoLocation: false` — the calendar endpoints 422 when a locationId query param is
 * attached, the same way `/calendars/events/appointments/{id}` does in the appointment adapter.
 */
export async function listAppointmentNotes(
  appointmentId: string,
  client: GhlClient = ghl(),
  limit = 20,
): Promise<AppointmentNote[]> {
  const data = await client.request<any>({
    path: `/calendars/appointments/${appointmentId}/notes`,
    params: { limit, offset: 0 },
    autoLocation: false,
  });
  const rows: any[] = Array.isArray(data?.notes) ? data.notes : [];
  return rows.map((n) => ({
    id: String(n.id),
    body: String(n.body ?? ''),
    contactId: n.contactId,
    createdBy: n.createdBy,
    dateAdded: n.dateAdded,
  }));
}

/**
 * Create a note. APPENDS — never call this without first checking the ledger for an existing id,
 * or the appointment accumulates a duplicate note on every run.
 *
 * `userId` should be the appointment's assigned GHL user so the note is attributed to the staffer
 * who ran the meeting rather than to a service account.
 */
export async function createAppointmentNote(
  appointmentId: string,
  body: string,
  userId: string | undefined,
  client: GhlClient = ghl(),
): Promise<AppointmentNote> {
  const data = await client.request<any>({
    method: 'POST',
    path: `/calendars/appointments/${appointmentId}/notes`,
    body: { ...(userId ? { userId } : {}), body },
    autoLocation: false,
  });
  const n = data?.note ?? data;
  return { id: String(n.id), body: String(n.body ?? ''), contactId: n.contactId, createdBy: n.createdBy, dateAdded: n.dateAdded };
}

/** Update a note in place. Verified: one note remains, new body, original dateAdded. */
export async function updateAppointmentNote(
  appointmentId: string,
  noteId: string,
  body: string,
  userId: string | undefined,
  client: GhlClient = ghl(),
): Promise<AppointmentNote> {
  const data = await client.request<any>({
    method: 'PUT',
    path: `/calendars/appointments/${appointmentId}/notes/${noteId}`,
    body: { ...(userId ? { userId } : {}), body },
    autoLocation: false,
  });
  const n = data?.note ?? data;
  return { id: String(n.id), body: String(n.body ?? ''), contactId: n.contactId, createdBy: n.createdBy, dateAdded: n.dateAdded };
}

/**
 * Set an appointment's status, and nothing else.
 *
 * Verified in the sandbox (§4b): sending ONLY these two fields left title, startTime, endTime,
 * address, calendarId, contactId and assignedUserId untouched, so there is no need to echo the
 * whole appointment back — and echoing it back would be the more dangerous call.
 *
 * `toNotify: false` asks GHL not to fire the appointment's own notifications. ⚠️ It was accepted on
 * every sandbox call but the sandbox has none of LRL's live workflows, so its effect on the real
 * location is still UNMEASURED. That is why the caller writes `showed` only — the status a wrongly
 * suppressed (or wrongly sent) notification cannot turn into a deleted activity.
 *
 * 🔴 The caller MUST diff first. GHL does not no-op an unchanged status: a byte-identical re-PUT
 * moved `dateUpdated` 12:07:15 → 12:07:25. Without a diff the nightly churns every Zoom-linked
 * appointment every night. (The API returns both `appointmentStatus` and a misspelled
 * `appoinmentStatus`; read the correctly spelled one.)
 */
export async function setAppointmentStatus(
  appointmentId: string,
  appointmentStatus: 'showed' | 'noshow' | 'confirmed',
  client: GhlClient = ghl(),
): Promise<{ appointmentStatus?: string }> {
  const data = await client.request<any>({
    method: 'PUT',
    path: `/calendars/events/appointments/${appointmentId}`,
    body: { appointmentStatus, toNotify: false },
    autoLocation: false,
  });
  const a = data?.appointment ?? data?.event ?? data;
  return { appointmentStatus: a?.appointmentStatus };
}
