// The noop contract, which is the entire reason lib/activities/zoomNotes.ts has a ledger.
//
// Two measured facts drive these tests:
//   1. GHL's Create Note APPENDS. Forget the note id and the client's appointment grows a second
//      identical note on every nightly run, forever.
//   2. GHL does NOT no-op an unchanged write — a byte-identical re-PUT still moved dateUpdated
//      (sandbox, 2026-09-10). So "send it again, it's harmless" is false; the caller must diff.
//
// hasDatabase is forced false so these also exercise the marker-scan fallback — the path a run
// takes with no DATABASE_URL, which is exactly when a missing guard would append duplicates.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ hasDatabase: false, getDb: () => { throw new Error('no db'); } }));

const flagForReview = vi.fn(async () => {});
vi.mock('../../sync/reviewQueue', () => ({ flagForReview: (...a: any[]) => (flagForReview as any)(...a) }));

const listAppointmentNotes = vi.fn(async (): Promise<any[]> => []);
const createAppointmentNote = vi.fn(async (_id: string, body: string) => ({ id: 'note-new', body }));
const updateAppointmentNote = vi.fn(async (_id: string, noteId: string, body: string) => ({ id: noteId, body }));
vi.mock('../../ghl/appointments', () => ({
  listAppointmentNotes: (...a: any[]) => (listAppointmentNotes as any)(...a),
  createAppointmentNote: (...a: any[]) => (createAppointmentNote as any)(...a),
  updateAppointmentNote: (...a: any[]) => (updateAppointmentNote as any)(...a),
}));

const resolveOccurrence = vi.fn(async () => ({ uuid: 'occ-1', startTime: '2026-09-09T14:00:00Z' }) as any);
const getMeetingSummary = vi.fn(async () => ({
  meetingUuid: 'occ-1',
  overview: 'They discussed the intake process.',
  details: [],
  nextSteps: ['Zach: send the overview'],
  docUrl: 'https://zoom.us/doc/abc',
}) as any);
vi.mock('../../zoom/summaries', async (orig) => ({
  ...(await orig<any>()),
  resolveOccurrence: (...a: any[]) => (resolveOccurrence as any)(...a),
  getMeetingSummary: (...a: any[]) => (getMeetingSummary as any)(...a),
}));

vi.mock('../../ghl/client', () => ({ ghl: () => ({ locationId: 'LOC' }) }));
vi.mock('../../zoom/client', async (orig) => ({ ...(await orig<any>()), zoom: () => ({}) }));

import { syncZoomNote } from '../zoomNotes';
import { buildNoteBody } from '../../zoom/noteBody';

const APPT = {
  id: 'appt-1',
  title: 'Zoom Meeting with Vihar Patel | Lean Rocket Lab Intake Meeting',
  address: 'https://us02web.zoom.us/j/94283456971',
  startTime: '2026-09-09T14:00:00Z',
  assignedUserId: 'user-1',
} as any;

const NOW = new Date('2026-09-10T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  listAppointmentNotes.mockResolvedValue([]);
  resolveOccurrence.mockResolvedValue({ uuid: 'occ-1', startTime: '2026-09-09T14:00:00Z' } as any);
  getMeetingSummary.mockResolvedValue({
    meetingUuid: 'occ-1',
    overview: 'They discussed the intake process.',
    details: [],
    nextSteps: ['Zach: send the overview'],
    docUrl: 'https://zoom.us/doc/abc',
  } as any);
});

describe('syncZoomNote — the noop contract', () => {
  it('creates a note the first time', async () => {
    const r = await syncZoomNote(APPT, { now: NOW });
    expect(r.outcome).toBe('created');
    expect(createAppointmentNote).toHaveBeenCalledTimes(1);
    expect(updateAppointmentNote).not.toHaveBeenCalled();
  });

  // The one that matters. An identical body must produce ZERO writes, not a harmless-looking
  // rewrite: GHL bumps dateUpdated either way, so a missing guard churns every Zoom-linked
  // appointment every night and `noop` becomes unreachable.
  it('reports noop and writes NOTHING when the body is unchanged', async () => {
    const existing = buildNoteBody(await getMeetingSummary());
    listAppointmentNotes.mockResolvedValue([{ id: 'note-9', body: existing }] as any);

    const r = await syncZoomNote(APPT, { now: NOW });

    expect(r.outcome).toBe('noop');
    expect(r.noteId).toBe('note-9');
    expect(createAppointmentNote).not.toHaveBeenCalled();
    expect(updateAppointmentNote).not.toHaveBeenCalled();
  });

  it('updates in place — never appends — when the summary has changed', async () => {
    listAppointmentNotes.mockResolvedValue([{ id: 'note-9', body: 'stale text with <!-- lrl:zoom-summary -->' }] as any);

    const r = await syncZoomNote(APPT, { now: NOW });

    expect(r.outcome).toBe('updated');
    expect(updateAppointmentNote).toHaveBeenCalledTimes(1);
    expect(createAppointmentNote).not.toHaveBeenCalled();
  });

  // Without the marker the writer cannot tell its own note from a staffer's, and would append.
  it('ignores a staff-authored note and creates its own', async () => {
    listAppointmentNotes.mockResolvedValue([{ id: 'human-1', body: 'Client called, rescheduling.' }] as any);
    const r = await syncZoomNote(APPT, { now: NOW });
    expect(r.outcome).toBe('created');
  });

  it('makes no write at all in dry-run, and says what it would have done', async () => {
    const r = await syncZoomNote(APPT, { now: NOW, dryRun: true });
    expect(r.outcome).toBe('would-create');
    expect(createAppointmentNote).not.toHaveBeenCalled();
    expect(updateAppointmentNote).not.toHaveBeenCalled();
  });
});

describe('syncZoomNote — the skips are named, never silent', () => {
  it('skips an appointment with no Zoom link', async () => {
    const r = await syncZoomNote({ ...APPT, address: 'Our office' }, { now: NOW });
    expect(r).toMatchObject({ outcome: 'skipped', reason: 'no-zoom-id' });
  });

  it('skips a meeting that has not happened yet', async () => {
    const r = await syncZoomNote({ ...APPT, startTime: '2026-09-20T14:00:00Z' }, { now: NOW });
    expect(r).toMatchObject({ outcome: 'skipped', reason: 'not-yet-held' });
  });

  // NO OCCURRENCE IS NOT EVIDENCE OF ABSENCE. The meeting may have moved to a phone call, run in
  // person, or used a personal room. We write nothing and queue it for a human — and we set
  // subjectId, because sync_review's unique index is (kind, record_id, subject_id) and Postgres
  // treats NULLs as distinct, so an unset subject inserts a fresh row every night.
  it('flags a missing occurrence for review instead of writing anything', async () => {
    resolveOccurrence.mockResolvedValue(null as any);

    const r = await syncZoomNote(APPT, { now: NOW });

    expect(r).toMatchObject({ outcome: 'skipped', reason: 'no-occurrence' });
    expect(createAppointmentNote).not.toHaveBeenCalled();
    expect(flagForReview).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'zoom-no-occurrence', recordId: 'appt-1', subjectId: '94283456971' }),
    );
  });

  it('skips when Zoom generated no summary for the occurrence', async () => {
    getMeetingSummary.mockResolvedValue(null as any);
    const r = await syncZoomNote(APPT, { now: NOW });
    expect(r).toMatchObject({ outcome: 'skipped', reason: 'no-summary' });
  });

  // A note whose only content is "an AI wrote this" is noise on a client's appointment.
  it('skips a summary with no recap and no next steps', async () => {
    getMeetingSummary.mockResolvedValue({ meetingUuid: 'occ-1', overview: '', details: [], nextSteps: [] } as any);
    const r = await syncZoomNote(APPT, { now: NOW });
    expect(r).toMatchObject({ outcome: 'skipped', reason: 'empty-summary' });
  });
});
