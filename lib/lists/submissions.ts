// lib/lists/submissions.ts — which forms/surveys did this contact JUST submit?
//
// WHY: GHL's Form Submitted webhook carries no form id, and the contact's Latest Attribution is a
// race. Measured 2026-11-25: every recent Intake submitter's Latest Attribution reads
// `medium: calendar` because the intake flow sends them straight on to book a meeting, which
// overwrites the survey. So the trigger also asks GHL for the contact's own recent submissions
// (both endpoints accept `q=<contactId>`, verified live the same day) and applies every form that
// has a rule. Rules are add-only and idempotent, so seeing the same submission twice is a noop.

import type { GhlClient } from '../ghl/client';

export const RECENT_SUBMISSION_WINDOW_MS = 2 * 3600_000;

interface Submission { formId?: string; surveyId?: string; contactId?: string; createdAt?: string; others?: { formId?: string } }

const idOf = (s: Submission) => s.formId || s.surveyId || s.others?.formId || undefined;

/** Form/survey ids this contact submitted inside the window, newest first, de-duped. */
export async function recentSubmissionFormIds(contactId: string, client: GhlClient, now: Date = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - RECENT_SUBMISSION_WINDOW_MS);
  const startAt = new Date(since.getTime() - 86_400_000).toISOString().slice(0, 10); // day granularity; filtered below
  const params = { locationId: client.locationId, q: contactId, limit: '20', startAt };
  const calls = ['/forms/submissions', '/surveys/submissions'].map((path) =>
    client.request<any>({ path, autoLocation: false, params }).then((d) => (d?.submissions ?? []) as Submission[]).catch(() => [] as Submission[]),
  );
  const all = (await Promise.all(calls)).flat()
    .filter((s) => s.contactId === contactId && s.createdAt && Date.parse(s.createdAt) >= since.getTime())
    .sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!));
  return Array.from(new Set(all.map(idOf).filter(Boolean) as string[]));
}
