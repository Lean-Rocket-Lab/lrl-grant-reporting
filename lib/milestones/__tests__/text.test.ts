import { describe, expect, it } from 'vitest';
import { classifyNote, htmlToText, stripQuotedReply } from '../text';
import { applyCap } from '../cap';
import type { MilestoneProposal } from '../schema';

describe('stripQuotedReply', () => {
  it('drops Gmail-style quoted history', () => {
    const t = 'Thanks, sounds good.\n\nOn Tue, 8 Sep 2026 at 12:14 PM Zach Kraabel <zach@x.org> wrote:\n> earlier text';
    expect(stripQuotedReply(t)).toBe('Thanks, sounds good.');
  });
  it('drops an Outlook header block', () => {
    const t = 'Approved!\n\nFrom: Blue Entity <hello@entity.blue>\nSent: Monday, August 17, 2026 10:53 AM\nTo: Melanie';
    expect(stripQuotedReply(t)).toBe('Approved!');
  });
  it('leaves an unquoted email alone', () => {
    expect(stripQuotedReply('Just a note.\nSecond line.')).toBe('Just a note.\nSecond line.');
  });
});

describe('htmlToText / classifyNote', () => {
  it('turns paragraphs into lines and decodes entities', () => {
    expect(htmlToText('<p>Plan for a Lunch &amp; Learn</p><p>Next</p>')).toBe('Plan for a Lunch & Learn\nNext');
  });
  it('classifies Zoom summaries by marker and drops the disclaimer', () => {
    const z = classifyNote('<!-- lrl:zoom-summary -->\n_AI-generated Zoom summary — may misattribute speakers._\n\n## Quick recap\nX');
    expect(z.kind).toBe('zoom_summary');
    expect(z.text.startsWith('## Quick recap')).toBe(true);
    expect(classifyNote('<p>Tyler has made progress</p>').kind).toBe('staff_note');
  });
});

const p = (over: Partial<MilestoneProposal>): MilestoneProposal => ({
  kind: 'new', milestone: 'm', definitionOfDone: 'd', readinessDimension: 'crl', category: 'other', targetDate: null,
  confidence: 'high', inferred: false, priority: 1, rankReason: '', evidence: [], relatedExistingMilestoneId: null, ...over,
});

describe('applyCap (spec §4a)', () => {
  it('keeps the best-ranked new proposals up to the free slots and always keeps completions', () => {
    const all = [p({ milestone: 'c', priority: 3 }), p({ milestone: 'done', kind: 'completion', priority: 0 }),
      p({ milestone: 'a', priority: 1 }), p({ milestone: 'b', priority: 2 }), p({ milestone: 'd', priority: 4 })];
    const r = applyCap(all, 0, 3);
    expect(r.proposals.map((x) => x.milestone)).toEqual(['a', 'b', 'c', 'done']);
    expect(r.alsoConsidered.map((x) => x.milestone)).toEqual(['d']);
  });
  it('proposes no new milestones when the company is already at the cap', () => {
    const r = applyCap([p({ milestone: 'a' }), p({ milestone: 'z', kind: 'completion' })], 3, 3);
    expect(r.proposals.map((x) => x.milestone)).toEqual(['z']);
    expect(r.alsoConsidered.map((x) => x.milestone)).toEqual(['a']);
  });
  it('fills only the remaining slots', () => {
    const r = applyCap([p({ milestone: 'a', priority: 1 }), p({ milestone: 'b', priority: 2 })], 2, 3);
    expect(r.proposals.map((x) => x.milestone)).toEqual(['a']);
  });
});
