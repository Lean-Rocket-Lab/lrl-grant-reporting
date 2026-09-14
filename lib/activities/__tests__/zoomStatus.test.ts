// Every case here is a REAL appointment from the 180-day read-only probe of 2026-09-14, named so
// that a future change which "simplifies" the rule fails against the data that shaped it rather
// than against an invented example. The four failure modes of §2's original table are the four
// tests marked THE BUG.

import { describe, expect, it } from 'vitest';
import { decideAppointmentStatus, isBot, isClientSide } from '../zoomStatus';
import type { ZoomParticipant } from '../../zoom/summaries';

const p = (name: string, email = ''): ZoomParticipant => ({ name, email });

const base = { hasOccurrence: true, hasSummary: true, participants: [] as ZoomParticipant[] };

describe('decideAppointmentStatus — never overwrite a human', () => {
  it('THE BUG: leaves an appointment a person marked cancelled (17 of 18 noshow writes landed here)', () => {
    // 2026-03-25 "Zoom Meeting with David Shaffer" — cancelled, Alex opened the room anyway.
    const d = decideAppointmentStatus({ ...base, currentStatus: 'cancelled', participants: [p('Alex Masten', 'alex@leanrocketlab.org')] });
    expect(d.action).toBe('leave');
    expect(d.reason).toBe('human-set');
    expect(d.status).toBeUndefined();
  });

  it('leaves an appointment already marked noshow by a human', () => {
    // 2026-09-09 "Zoom Meeting with Michaela Holdridge" — already noshow in GHL.
    const d = decideAppointmentStatus({ ...base, currentStatus: 'noshow', participants: [p('Alex Masten', 'alex@leanrocketlab.org')] });
    expect(d.action).toBe('leave');
    expect(d.reason).toBe('human-set');
  });

  it('human-set wins even when a client is plainly present', () => {
    const d = decideAppointmentStatus({ ...base, currentStatus: 'cancelled', participants: [p('Alex Masten', 'alex@leanrocketlab.org'), p('Vihar Patel')] });
    expect(d.action).toBe('leave');
    expect(d.reason).toBe('human-set');
  });
});

describe('decideAppointmentStatus — a summary alone proves the meeting happened', () => {
  it("THE BUG: a summary with only the host is `showed`, not a no-show", () => {
    // 2026-09-02 Chad Petosky. Participants: Alex alone — but a 1,915-char summary of a real
    // conversation, so the client dialled in by phone. §2's rule wrote `noshow` here and
    // NON_EVENT_STATUSES would then have kept a funder-reportable intake from ever being ingested.
    const d = decideAppointmentStatus({ ...base, currentStatus: 'confirmed', hasSummary: true, participants: [p('Alex Masten', 'alex@leanrocketlab.org')] });
    expect(d.action).toBe('write');
    expect(d.status).toBe('showed');
    expect(d.reason).toBe('summary-exists');
  });

  it('a summary outranks even an empty participant list', () => {
    const d = decideAppointmentStatus({ ...base, currentStatus: 'confirmed', hasSummary: true, participants: [] });
    expect(d.status).toBe('showed');
  });

  it('NEVER writes noshow while any positive evidence exists', () => {
    const withEvidence = [
      { ...base, currentStatus: 'confirmed', hasSummary: true, participants: [] },
      { ...base, currentStatus: 'confirmed', hasSummary: true, participants: [p('Alex Masten', 'alex@leanrocketlab.org')] },
      { ...base, currentStatus: 'confirmed', hasSummary: false, participants: [p('Jojo Rodriguez')] },
      { ...base, currentStatus: 'confirmed', hasSummary: true, participants: [p("Brandon's Notetaker")] },
    ];
    for (const c of withEvidence) expect(decideAppointmentStatus(c).status).not.toBe('noshow');
  });
});

describe('decideAppointmentStatus — noshow when there is no evidence at all', () => {
  it('host alone with no summary is a no-show', () => {
    // Zach, 2026-09-14: "If there is not really a zoom summary then we should mark it as noshow...
    // I would prefer to review and update later rather than have a queue that don't get set."
    const d = decideAppointmentStatus({ ...base, currentStatus: 'confirmed', hasSummary: false, participants: [p('Alex Masten', 'alex@leanrocketlab.org')] });
    expect(d.action).toBe('write');
    expect(d.status).toBe('noshow');
    expect(d.reason).toBe('host-only-no-summary');
  });

  it('no participant records and no summary is a no-show', () => {
    const d = decideAppointmentStatus({ ...base, currentStatus: 'confirmed', hasSummary: false, participants: [] });
    expect(d.action).toBe('write');
    expect(d.status).toBe('noshow');
    expect(d.reason).toBe('no-participants');
  });

  it('is a NOOP when the status is already noshow', () => {
    const d = decideAppointmentStatus({ ...base, currentStatus: 'noshow', hasSummary: false, participants: [] });
    expect(d.action).toBe('leave');
    // NON_EVENT_STATUSES catches this first: a human may have set it, and either way it is correct.
    expect(d.reason).toBe('human-set');
  });
});

describe('decideAppointmentStatus — bots are not clients', () => {
  it('THE BUG: a notetaker bot alone does not mean the client showed', () => {
    // 2026-05-05 Mohamed Hagras — the ONLY participant was "Brandon's Notetaker". No LRL human,
    // no client, no summary. §2's rule wrote `showed`; a bot in an empty room is a no-show.
    const d = decideAppointmentStatus({ ...base, currentStatus: 'confirmed', hasSummary: false, participants: [p("Brandon's Notetaker")] });
    expect(d.status).not.toBe('showed');
    expect(d.status).toBe('noshow');
  });

  it('staff plus their bot is still nobody from the client side', () => {
    // 2026-05-27 Shane Ison — Brandon Bartel (LRL) + Brandon's Notetaker.
    const d = decideAppointmentStatus({
      ...base,
      currentStatus: 'confirmed',
      hasSummary: false,
      participants: [p('Brandon Bartel', 'brandon@leanrocketlab.org'), p("Brandon's Notetaker")],
    });
    expect(d.status).not.toBe('showed');
  });

  it('recognises the common assistant names', () => {
    for (const n of ["Brandon's Notetaker", 'Otter.ai', 'Fireflies.ai Notetaker', 'Fathom Notetaker', 'Zoom AI Companion', 'Recording Bot']) {
      expect(isBot(p(n))).toBe(true);
    }
    expect(isBot(p('Vihar Patel'))).toBe(false);
  });

  it('a real client in the room outweighs the bots beside them', () => {
    // 2026-07-09 Ebbin Daniel — a crowded room: staff, two notetakers, and real attendees.
    const d = decideAppointmentStatus({
      ...base,
      currentStatus: 'confirmed',
      participants: [
        p('Zach Kraabel', 'zach@leanrocketlab.org'),
        p('MACHINE AI SOLUTIONS LLC'),
        p("Brandon's Notetaker"),
        p('Ebbin Daniel'),
      ],
    });
    expect(d.action).toBe('write');
    expect(d.status).toBe('showed');
    expect(d.clientNames).toContain('Ebbin Daniel');
    expect(d.clientNames).not.toContain("Brandon's Notetaker");
  });
});

describe('decideAppointmentStatus — the showed path', () => {
  it('writes showed for an external attendee with no email, which is nearly all of them', () => {
    // 2026-03-25 Jojo Rodriguez — `user_email` empty, as it is for almost every client.
    const d = decideAppointmentStatus({ ...base, currentStatus: 'confirmed', participants: [p('Alex Masten', 'alex@leanrocketlab.org'), p('Jojo Rodriguez')] });
    expect(d.action).toBe('write');
    expect(d.status).toBe('showed');
  });

  it('writes showed for an external attendee with a real non-LRL address', () => {
    // 2026-04-22 Daniel Sousa Schulman <dschul@umich.edu>.
    const d = decideAppointmentStatus({ ...base, currentStatus: 'confirmed', participants: [p('Zach Kraabel', 'zach@leanrocketlab.org'), p('Daniel Sousa Schulman', 'dschul@umich.edu')] });
    expect(d.action).toBe('write');
    expect(d.status).toBe('showed');
  });

  it('writes showed when the client joined but no AI summary exists', () => {
    // Recording off is not absence: participants are direct evidence of joining.
    const d = decideAppointmentStatus({ ...base, currentStatus: 'confirmed', hasSummary: false, participants: [p('Alex Masten', 'alex@leanrocketlab.org'), p('Karen Hyatt')] });
    expect(d.action).toBe('write');
    expect(d.status).toBe('showed');
  });

  it('is a NOOP when the status is already showed — GHL does not no-op an unchanged write', () => {
    const d = decideAppointmentStatus({ ...base, currentStatus: 'showed', participants: [p('Alex Masten', 'alex@leanrocketlab.org'), p('Jojo Rodriguez')] });
    expect(d.action).toBe('leave');
    expect(d.reason).toBe('already-correct');
  });

  it('counts a rejoin once (the list arrives already deduped by name)', () => {
    const d = decideAppointmentStatus({ ...base, currentStatus: 'confirmed', participants: [p('Alex Masten', 'alex@leanrocketlab.org'), p('Vihar Patel')] });
    expect(d.clientNames).toEqual(['Vihar Patel']);
  });
});

describe('decideAppointmentStatus — §2 row 3, the safety rule', () => {
  it('THE BUG IT PREVENTS: no occurrence leaves the status entirely alone', () => {
    // 6 of 86 appointments. The meeting may have moved to a phone call, run in person, or used a
    // personal room. Writing noshow on absence of evidence deletes a real meeting.
    const d = decideAppointmentStatus({ ...base, currentStatus: 'confirmed', hasOccurrence: false });
    expect(d.action).toBe('leave');
    expect(d.reason).toBe('no-occurrence');
  });
});

describe('isClientSide', () => {
  it('treats an LRL address as staff regardless of name', () => {
    expect(isClientSide(p('Sierra Sibson', 'sierra@leanrocketlab.org'))).toBe(false);
  });

  it('treats the host under a second device as the host', () => {
    expect(isClientSide(p('Alex Masten'), { hostName: 'Alex Masten' })).toBe(false);
    expect(isClientSide(p('alex masten'), { hostName: 'Alex  Masten' })).toBe(false);
  });

  it('catches staff who joined without signing in, when their name is known', () => {
    // 2026-07-09 had both "BrandonBartel" and "Brandon Bartel" with no email, counted as two
    // separate external attendees. Normalising the name collapses the spelling difference.
    expect(isClientSide(p('BrandonBartel'), { staffNames: ['Brandon Bartel'] })).toBe(false);
    expect(isClientSide(p('Brandon Bartel'), { staffNames: ['Brandon Bartel'] })).toBe(false);
  });

  it('still counts an unknown no-email guest as client-side — externals are exactly who lack one', () => {
    expect(isClientSide(p('Jayana Edwards'))).toBe(true);
  });

  it('ignores a participant with no usable name', () => {
    expect(isClientSide(p('   '))).toBe(false);
  });
});
