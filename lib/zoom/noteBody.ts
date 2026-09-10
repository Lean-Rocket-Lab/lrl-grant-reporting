// lib/zoom/noteBody.ts — turn a Zoom summary into the note body written onto a GHL appointment.
//
// The brief's §4 assumed we would have to slice a markdown blob and truncate it. We don't: the
// summary comes back as DISCRETE FIELDS (summary_overview, next_steps[], summary_details[],
// summary_doc_url), so the note is ASSEMBLED rather than cut, and the 5,000-char GHL cap stops
// being the normal case. Measured bodies: 851-char overview + 8 next steps (Vihar/Alex),
// 3,240 chars total (Aveek/Zach).
//
// What goes in, and why only this:
//   - overview and next steps VERBATIM — the two blocks a staffer actually re-reads
//   - a link to the Zoom doc for the sectioned detail
//   - a provenance line, because §6b found the summary MISATTRIBUTES SPEAKERS: it credited Zach's
//     explanation of LRL's own programs to Joe, and put Joe's consulting pricing in a section
//     framed as LRL's. Excellent as human context; not trustworthy as structured fact. Anyone
//     reading this note downstream needs to know an AI wrote it.
//
// Detail sections are deliberately NOT inlined. They are the least-read and least-reliable part,
// they are what pushes past the cap, and summary_doc_url already holds them.

import type { ZoomSummary } from './summaries';

/** GHL's documented cap on an appointment note body. */
export const NOTE_BODY_LIMIT = 5000;

export const PROVENANCE = '_AI-generated Zoom summary — may misattribute speakers. Not a source of record._';

/** Marks a note as ours, so a human (and a future migration) can tell it from staff-authored text. */
export const NOTE_MARKER = '<!-- lrl:zoom-summary -->';

function truncateTo(s: string, limit: number): string {
  if (s.length <= limit) return s;
  // Cut on a paragraph boundary where possible so a next step is never severed mid-sentence.
  const cut = s.lastIndexOf('\n\n', limit - 20);
  const head = cut > limit * 0.5 ? s.slice(0, cut) : s.slice(0, limit - 20);
  return `${head.trimEnd()}\n\n_[truncated]_`;
}

export function buildNoteBody(summary: ZoomSummary): string {
  const parts: string[] = [NOTE_MARKER, PROVENANCE, ''];

  if (summary.overview) {
    parts.push('## Quick recap', summary.overview.trim(), '');
  }

  if (summary.nextSteps.length) {
    parts.push('## Next steps');
    for (const step of summary.nextSteps) parts.push(`- ${step.trim()}`);
    parts.push('');
  }

  if (summary.docUrl) {
    parts.push(`Full summary: ${summary.docUrl}`);
  } else if (summary.details.length) {
    // No doc link and we are not inlining sections — say so rather than silently dropping them.
    parts.push(`_${summary.details.length} further section(s) in Zoom; no shareable doc link was returned._`);
  }

  return truncateTo(parts.join('\n').replace(/\n{3,}/g, '\n\n').trim(), NOTE_BODY_LIMIT);
}

/**
 * True when a summary carries nothing worth writing.
 *
 * A note that says only "an AI wrote this" is noise on a client's appointment.
 */
export function isEmptySummary(summary: ZoomSummary): boolean {
  return !summary.overview && summary.nextSteps.length === 0;
}
