// lib/lists/eventMap.ts — which lists an event maps to, read from the Event_list_db sheet.
//
// Event_list_db (Google Sheet, shared drive) holds one row per GHL event with a "Tags" column such as
// "sama, manutech, i40". It is kept current by the website's event sync (column "Last Synced").
// The registration webhook carries the GHL event id and name; the id is matched first (parsed from
// the "Embed Code" iframe src or the URL, ".../event-details/<id>"), the name second.
//
// ACCESS: the app reads it with the service account in GOOGLE_SERVICE_ACCOUNT_EMAIL. The sheet must
// be shared with that account (Viewer) or every lookup reports `event-map-unavailable`.

import { sheets } from '../sheets';

export const EVENT_SHEET_ID = process.env.LISTS_EVENT_SHEET_ID || '1PymQ3aBQVGF2LfsvKF0EIsqswHa2B-3lEFm6jWfJ-KI';
const CACHE_MS = 10 * 60 * 1000;

export interface EventRow {
  eventId: string | null;
  name: string;
  tags: string;
}

let cache: { at: number; rows: EventRow[] } | null = null;

const EVENT_ID_IN_URL = /event-details\/([A-Za-z0-9]{16,40})/;

/** Turn the sheet's values (header row first) into rows. Exported for tests. */
export function parseEventSheet(values: string[][]): EventRow[] {
  const [header, ...rows] = values;
  if (!header) return [];
  const col = (name: string) => header.findIndex((h) => String(h).trim().toLowerCase() === name);
  const iEmbed = col('embed code');
  const iUrl = col('url');
  const iName = col('event name');
  const iTags = col('tags');
  if (iName < 0 || iTags < 0) throw new Error('Event_list_db: missing "Event Name" or "Tags" column');
  return rows
    .filter((r) => r && String(r[iName] ?? '').trim())
    .map((r) => {
      const src = `${iEmbed >= 0 ? r[iEmbed] ?? '' : ''} ${iUrl >= 0 ? r[iUrl] ?? '' : ''}`;
      return {
        eventId: src.match(EVENT_ID_IN_URL)?.[1] ?? null,
        name: String(r[iName]).trim(),
        tags: String(r[iTags] ?? '').trim(),
      };
    });
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Find the event row: id first, then exact (normalised) name. */
export function findEventRow(rows: EventRow[], eventId?: string, eventName?: string): { row: EventRow; matchedBy: 'id' | 'name' } | null {
  if (eventId) {
    const byId = rows.find((r) => r.eventId === eventId);
    if (byId) return { row: byId, matchedBy: 'id' };
  }
  if (eventName) {
    const n = norm(eventName);
    const byName = rows.filter((r) => norm(r.name) === n);
    if (byName.length === 1) return { row: byName[0], matchedBy: 'name' };
  }
  return null;
}

export async function loadEventRows(opts: { force?: boolean } = {}): Promise<EventRow[]> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: EVENT_SHEET_ID, range: 'A1:Z1000' });
  const rows = parseEventSheet((res.data.values ?? []) as string[][]);
  cache = { at: Date.now(), rows };
  return rows;
}

/** Test hook. */
export function _resetEventCache() { cache = null; }
