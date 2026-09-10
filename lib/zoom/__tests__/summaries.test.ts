// Covers the four Zoom behaviours that were measured live and that a refactor could silently
// undo. Each test names the real-world failure it prevents, because "it returns a string" is not
// why any of this code is shaped the way it is.

import { describe, expect, it } from 'vitest';
import { encodeMeetingUuid } from '../client';
import { ZoomApiError } from '../errors';
import { listPastParticipants, resolveOccurrence } from '../summaries';
import { buildNoteBody, NOTE_BODY_LIMIT, NOTE_MARKER, isEmptySummary } from '../noteBody';
import type { ZoomSummary } from '../summaries';

const summary = (over: Partial<ZoomSummary> = {}): ZoomSummary => ({
  meetingUuid: 'uuid-1',
  overview: 'Zach and the client discussed the intake process.',
  details: [{ label: 'Pricing', summary: 'A range was mentioned.' }],
  nextSteps: ['Zach: send the program overview', 'Client: return the intake form'],
  docUrl: 'https://zoom.us/doc/abc',
  ...over,
});

/** A fake ZoomClient: routes by path, records what was asked for. */
function fakeClient(routes: Record<string, unknown>) {
  const seen: string[] = [];
  return {
    seen,
    client: {
      async request({ path }: { path: string }) {
        seen.push(path);
        for (const [re, body] of Object.entries(routes)) {
          if (new RegExp(re).test(path)) return body;
        }
        // A real ZoomClient throws ZoomApiError for every non-OK status (client.ts:168), so the
        // fake must too. Bolting `.status` onto a bare Error made this fallback something production
        // never produces, and `listPastInstances` narrows its 404 catch to ZoomApiError deliberately:
        // duck-typing `.status` there would swallow unrelated failures that happen to carry one.
        throw new ZoomApiError({ status: 404, body: { message: `unrouted ${path}` }, method: 'GET', path, attempts: 1 });
      },
    } as any,
  };
}

describe('encodeMeetingUuid', () => {
  // A UUID starting with "/" or containing "//" must be DOUBLE encoded or Zoom answers
  // "Meeting does not exist" — a wrong-looking error for a right-looking id, which reads as
  // missing data rather than a bug.
  it('single-encodes an ordinary uuid', () => {
    expect(encodeMeetingUuid('i9kNvuXJTHS2H1BPY1s7Sg==')).toBe('i9kNvuXJTHS2H1BPY1s7Sg%3D%3D');
  });

  it('double-encodes a uuid that starts with a slash', () => {
    expect(encodeMeetingUuid('/abc==')).toBe(encodeURIComponent(encodeURIComponent('/abc==')));
  });

  it('double-encodes a uuid containing a double slash', () => {
    expect(encodeMeetingUuid('ab//cd')).toBe(encodeURIComponent(encodeURIComponent('ab//cd')));
  });
});

describe('resolveOccurrence', () => {
  // meeting_number is NOT unique per occurrence: the recurring S&MA LVL10 meeting returned the
  // same number for 8/21 and 8/28 with different UUIDs. Joining on the number alone attaches the
  // wrong week's notes to a client's appointment and looks entirely plausible doing it.
  const instances = {
    'past_meetings/.*/instances': {
      meetings: [
        { uuid: 'week-1', start_time: '2026-08-21T14:00:00Z' },
        { uuid: 'week-2', start_time: '2026-08-28T14:00:00Z' },
      ],
    },
  };

  it('picks the occurrence matching the appointment date, not merely the first', async () => {
    const { client } = fakeClient(instances);
    const occ = await resolveOccurrence('99387743679', new Date('2026-08-28T14:05:00Z'), client);
    expect(occ?.uuid).toBe('week-2');
  });

  it('picks the earlier occurrence for the earlier appointment', async () => {
    const { client } = fakeClient(instances);
    const occ = await resolveOccurrence('99387743679', new Date('2026-08-21T13:58:00Z'), client);
    expect(occ?.uuid).toBe('week-1');
  });

  it('returns null rather than guessing when nothing is inside the window', async () => {
    const { client } = fakeClient(instances);
    const occ = await resolveOccurrence('99387743679', new Date('2026-09-04T14:00:00Z'), client);
    expect(occ).toBeNull();
  });

  it('treats a 404 (meeting never ran) as no occurrence, not an error', async () => {
    const { client } = fakeClient({});
    await expect(resolveOccurrence('1', new Date(), client)).resolves.toBeNull();
  });
});

describe('listPastParticipants', () => {
  // Measured: a rejoin produces a DUPLICATE row (Vihar Patel appeared twice in a 3-record
  // response), and external guests carry an EMPTY user_email. Counting rows would score a solo
  // host who dropped and rejoined as two attendees.
  it('dedupes a rejoin and preserves the empty external email', async () => {
    const { client } = fakeClient({
      'participants': {
        participants: [
          { name: 'Alex Masten', user_email: 'alex@leanrocketlab.org' },
          { name: 'Vihar Patel', user_email: '' },
          { name: 'Vihar Patel', user_email: '' },
        ],
      },
    });
    const ps = await listPastParticipants('uuid-1', client);
    expect(ps).toHaveLength(2);
    expect(ps.find((p) => p.name === 'Vihar Patel')?.email).toBe('');
  });

  it('keeps whichever sighting carried an email', async () => {
    const { client } = fakeClient({
      'participants': {
        participants: [
          { name: 'Sean Wu', user_email: '' },
          { name: 'Sean Wu', user_email: 'sean@signal-wise.com' },
        ],
      },
    });
    const ps = await listPastParticipants('uuid-1', client);
    expect(ps).toEqual([{ name: 'Sean Wu', email: 'sean@signal-wise.com' }]);
  });
});

describe('buildNoteBody', () => {
  it('carries the marker, the provenance warning, the recap, the steps and the doc link', () => {
    const body = buildNoteBody(summary());
    expect(body).toContain(NOTE_MARKER);
    expect(body).toMatch(/may misattribute speakers/);
    expect(body).toContain('## Quick recap');
    expect(body).toContain('- Zach: send the program overview');
    expect(body).toContain('https://zoom.us/doc/abc');
  });

  // The marker is what lets a later run recognise its own note when the ledger cannot help.
  // Without it the writer appends a second identical note on every run, forever.
  it('always emits the marker even for a minimal summary', () => {
    expect(buildNoteBody(summary({ nextSteps: [], docUrl: undefined, details: [] }))).toContain(NOTE_MARKER);
  });

  it('does not inline detail sections, but says they exist when there is no doc link', () => {
    const body = buildNoteBody(summary({ docUrl: undefined }));
    expect(body).not.toContain('A range was mentioned.');
    expect(body).toMatch(/1 further section/);
  });

  it('stays inside GHL’s 5,000-char cap and marks the cut', () => {
    const body = buildNoteBody(summary({ overview: 'x'.repeat(9000) }));
    expect(body.length).toBeLessThanOrEqual(NOTE_BODY_LIMIT);
    expect(body).toMatch(/\[truncated\]/);
  });

  it('treats a summary with no recap and no steps as empty, so we write no note at all', () => {
    expect(isEmptySummary(summary({ overview: '', nextSteps: [] }))).toBe(true);
    expect(isEmptySummary(summary())).toBe(false);
  });
});
