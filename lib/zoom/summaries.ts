// lib/zoom/summaries.ts — resolve a GHL appointment's Zoom meeting to ONE occurrence, then read
// that occurrence's AI Companion summary and participant list.
//
// Everything here was probed live 2026-09-09; the findings are in
// docs/sprints/zoom-notes-appointments.md §1b. The three that shape this file:
//
//  1. `meeting_number` is NOT unique per occurrence. The recurring "S&MA LVL10 Meeting" returns
//     99387743679 for BOTH 8/21 and 8/28 with different UUIDs. Joining on the number alone
//     attaches the wrong week's notes to a meeting and looks completely plausible. The join is
//     therefore number + the appointment's start time -> a single meeting_uuid.
//  2. No cloud recording and no transcript are involved — every meeting probed had
//     has_recording:false / has_transcript:false and has_summary:true. Anyone who checks
//     recordings first will wrongly conclude this is dead. THE SUMMARY IS THE ASSET.
//  3. The list endpoint's `total_records` LIED: it reported 300 (the page_size cap) when the true
//     count was 571. Always follow next_page_token; a page-1-only reader under-reports by half
//     and looks fine doing it.

import { ZoomClient, encodeMeetingUuid, zoom } from './client';
import { ZoomApiError } from './errors';

export interface ZoomOccurrence {
  uuid: string;
  /** ISO start time of this occurrence. */
  startTime: string;
}

export interface ZoomSummary {
  meetingUuid: string;
  meetingId?: number;
  hostEmail?: string;
  topic?: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  overview: string;
  /** Section objects as Zoom returns them; PROSE, never a source of structured facts (§6b). */
  details: Array<{ label?: string; summary?: string }>;
  nextSteps: string[];
  docUrl?: string;
}

export interface ZoomParticipant {
  name: string;
  /** Empty for external guests — measured. Never key "external" off the email domain alone. */
  email: string;
}

/** How far from the appointment's start an occurrence may sit and still be the same meeting. */
export const OCCURRENCE_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Every ended instance of a meeting number, oldest first. Empty when the meeting never ran. */
export async function listPastInstances(
  meetingNumber: string,
  client: ZoomClient = zoom(),
): Promise<ZoomOccurrence[]> {
  try {
    const data = await client.request<any>({ path: `/past_meetings/${encodeURIComponent(meetingNumber)}/instances` });
    const rows: any[] = Array.isArray(data?.meetings) ? data.meetings : [];
    return rows
      .filter((r) => r?.uuid)
      .map((r) => ({ uuid: String(r.uuid), startTime: String(r.start_time ?? '') }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  } catch (e) {
    // 404 = this meeting number never held an occurrence. That is an ANSWER ("no evidence the
    // meeting happened"), not a failure, and the caller must be able to tell the two apart —
    // §2's third row leaves the appointment status alone rather than writing noshow.
    if (e instanceof ZoomApiError && e.status === 404) return [];
    throw e;
  }
}

/**
 * The occurrence that corresponds to a specific appointment, or null.
 *
 * Returns null rather than guessing when nothing lands inside the window: a wrong occurrence
 * writes another meeting's notes onto a client's appointment.
 */
export async function resolveOccurrence(
  meetingNumber: string,
  appointmentStart: Date,
  client: ZoomClient = zoom(),
  windowMs: number = OCCURRENCE_MATCH_WINDOW_MS,
): Promise<ZoomOccurrence | null> {
  const instances = await listPastInstances(meetingNumber, client);
  if (!instances.length) return null;
  const target = appointmentStart.getTime();
  let best: ZoomOccurrence | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const occ of instances) {
    const t = Date.parse(occ.startTime);
    if (Number.isNaN(t)) continue;
    const delta = Math.abs(t - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = occ;
    }
  }
  return best && bestDelta <= windowMs ? best : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x : typeof x?.summary === 'string' ? x.summary : ''))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The AI Companion summary for one occurrence, or null when Zoom generated none. */
export async function getMeetingSummary(
  meetingUuid: string,
  client: ZoomClient = zoom(),
): Promise<ZoomSummary | null> {
  let data: any;
  try {
    data = await client.request<any>({ path: `/meetings/${encodeMeetingUuid(meetingUuid)}/meeting_summary` });
  } catch (e) {
    if (e instanceof ZoomApiError && e.status === 404) return null;
    throw e;
  }
  if (!data) return null;
  const details: Array<{ label?: string; summary?: string }> = Array.isArray(data.summary_details)
    ? data.summary_details.map((d: any) =>
        typeof d === 'string' ? { summary: d } : { label: d?.label, summary: d?.summary },
      )
    : [];
  return {
    meetingUuid: String(data.meeting_uuid ?? meetingUuid),
    meetingId: data.meeting_id,
    hostEmail: data.meeting_host_email,
    topic: data.meeting_topic,
    title: data.summary_title,
    startTime: data.meeting_start_time,
    endTime: data.meeting_end_time,
    overview: String(data.summary_overview ?? '').trim(),
    details,
    nextSteps: asStringArray(data.next_steps),
    docUrl: data.summary_doc_url,
  };
}

/**
 * Participants for one occurrence, deduped by name.
 *
 * ⚠️ Two measured traps. External guests come back with an EMPTY user_email, so "external" can
 * never be decided by email domain alone. And a rejoin produces a DUPLICATE row — Vihar Patel
 * appeared twice in a three-record response — so a solo host who dropped and rejoined would read
 * as two attendees and score a false `showed` if you counted rows.
 */
export async function listPastParticipants(
  meetingUuid: string,
  client: ZoomClient = zoom(),
): Promise<ZoomParticipant[]> {
  const out = new Map<string, ZoomParticipant>();
  let token = '';
  for (let page = 0; page < 20; page++) {
    let data: any;
    try {
      data = await client.request<any>({
        path: `/past_meetings/${encodeMeetingUuid(meetingUuid)}/participants`,
        params: { page_size: 300, next_page_token: token || undefined },
      });
    } catch (e) {
      if (e instanceof ZoomApiError && e.status === 404) break;
      throw e;
    }
    for (const p of data?.participants ?? []) {
      const name = String(p?.name ?? '').trim();
      const email = String(p?.user_email ?? '').trim();
      const key = (name || email).toLowerCase();
      if (!key) continue;
      const prev = out.get(key);
      // Keep whichever sighting carried an email — a rejoin can report it on only one row.
      if (!prev || (!prev.email && email)) out.set(key, { name, email });
    }
    token = data?.next_page_token ?? '';
    if (!token) break;
  }
  return Array.from(out.values());
}

export interface SummaryListEntry {
  meetingUuid: string;
  meetingId?: number;
  hostEmail?: string;
  topic?: string;
  startTime?: string;
}

/**
 * Every summary the account can see in a date range, across ALL pages.
 *
 * `from`/`to` are YYYY-MM-DD. Do not trust `total_records` — see the header.
 */
export async function listMeetingSummaries(
  from: string,
  to: string,
  client: ZoomClient = zoom(),
): Promise<SummaryListEntry[]> {
  const out: SummaryListEntry[] = [];
  let token = '';
  for (let page = 0; page < 50; page++) {
    const data = await client.request<any>({
      path: '/meetings/meeting_summaries',
      params: { from, to, page_size: 300, next_page_token: token || undefined },
    });
    for (const s of data?.summaries ?? []) {
      out.push({
        meetingUuid: String(s.meeting_uuid ?? ''),
        meetingId: s.meeting_id,
        hostEmail: s.meeting_host_email,
        topic: s.meeting_topic,
        startTime: s.meeting_start_time,
      });
    }
    token = data?.next_page_token ?? '';
    if (!token) break;
  }
  return out;
}
