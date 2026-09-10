// lib/zoom/config.ts — resolve Zoom Server-to-Server OAuth config from the environment.
//
// A Server-to-Server OAuth app authenticates with the ACCOUNT, not a user, which is the whole
// point: a user-scoped token only reaches meetings that user hosted. Measured 2026-09-09 on the
// account credential — 571 summaries across FOUR hosts (zach 289, alex 228, sierra 53, ken 1) —
// so a Zach-scoped token would have silently returned nothing for most grant-reportable meetings.
// See docs/sprints/zoom-notes-appointments.md §1b.
//
//   ZOOM_ACCOUNT_ID           (required) — App Credentials tab
//   ZOOM_CLIENT_ID            (required)
//   ZOOM_CLIENT_SECRET        (required)
//   ZOOM_WEBHOOK_SECRET_TOKEN (optional) — only for the future summary_completed webhook
//
// ⚠️ Scope names are GRANULAR now. The classic `meeting:read:admin` / `report:read:admin` do not
// appear in the picker any more, and LISTING summaries is a DIFFERENT scope from READING one:
//   meeting:read:summary:admin            read one summary body
//   meeting:read:list_summaries:admin     list summaries over a date range
//   meeting:read:list_past_instances:admin  resolve a meeting number to an occurrence UUID
//   meeting:read:past_meeting:admin
//   meeting:read:list_past_participants:admin  attendance
// `dashboard:read:list_meeting_participants:admin` grants fine and is a DEAD END — the endpoint is
// plan-gated to Business+ with Dashboard, and LRL is on Pro.

export interface ZoomConfig {
  baseUrl: string;
  tokenUrl: string;
  accountId: string;
  clientId: string;
  clientSecret: string;
  userAgent: string;
}

const API_BASE = 'https://api.zoom.us/v2';
const TOKEN_URL = 'https://zoom.us/oauth/token';

/** True when Zoom credentials are present — lets callers degrade instead of throwing. */
export const hasZoom = Boolean(
  process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET,
);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Add it to .env.local (see lib/zoom/config.ts), and to ` +
        `Vercel + GitHub Actions secrets before anything scheduled depends on it.`,
    );
  }
  return v;
}

export function getZoomConfig(): ZoomConfig {
  return {
    baseUrl: process.env.ZOOM_API_BASE || API_BASE,
    tokenUrl: process.env.ZOOM_TOKEN_URL || TOKEN_URL,
    accountId: requireEnv('ZOOM_ACCOUNT_ID'),
    clientId: requireEnv('ZOOM_CLIENT_ID'),
    clientSecret: requireEnv('ZOOM_CLIENT_SECRET'),
    userAgent: 'lrl-ops-app/1.0',
  };
}
