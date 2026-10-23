// lib/milestones/text.ts — pure text helpers for the suggester's source gathering. No I/O.

/** HTML → readable plain text (good enough for note/email bodies; not a general sanitizer). */
export function htmlToText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Lines that begin the quoted history of a reply. Everything from the first match on is dropped.
const QUOTE_STARTS: RegExp[] = [
  /^On .{6,200}wrote:\s*$/m,                              // Gmail / Apple: "On Tue, 8 Sep 2026 at 12:14 PM X wrote:"
  /^On .{6,200}\n.{0,200}wrote:\s*$/m,                    // same, wrapped onto two lines
  /^-{2,}\s*Original Message\s*-{2,}/im,                  // Outlook
  /^From:\s.+\n(?:Sent|Date):\s.+/m,                       // Outlook header block
  /^_{5,}\s*$/m,                                          // Outlook separator line
];

/** Strip quoted reply history so each email is read once (spec §3a). Signature trimming is not attempted. */
export function stripQuotedReply(text: string): string {
  let cut = text.length;
  for (const re of QUOTE_STARTS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  // Also drop any trailing block of ">"-quoted lines.
  const kept = text.slice(0, cut).split('\n');
  while (kept.length && /^\s*>/.test(kept[kept.length - 1])) kept.pop();
  return kept.join('\n').trim();
}

export const ZOOM_SUMMARY_MARKER = '<!-- lrl:zoom-summary -->';

/** Note body → { kind, text }. Zoom summaries carry our marker; everything else is staff-written. */
export function classifyNote(body: string): { kind: 'zoom_summary' | 'staff_note'; text: string } {
  const kind = body.includes(ZOOM_SUMMARY_MARKER) ? 'zoom_summary' : 'staff_note';
  let text = htmlToText(body);
  // The disclaimer line our Zoom writer prepends adds nothing for the model.
  text = text.replace(/^_?AI-generated Zoom summary[^\n]*\n?/m, '').trim();
  return { kind, text };
}

/** Hard cap so one long thread can't crowd out the rest of a company's history. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [clipped ${text.length - max} chars]`;
}
