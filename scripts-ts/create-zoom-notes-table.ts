// scripts-ts/create-zoom-notes-table.ts — create the zoom_appointment_notes table.
//
//   npx vite-node scripts-ts/create-zoom-notes-table.ts
//
// Additive and idempotent (IF NOT EXISTS), safe to re-run and safe on prod — same approach as
// create-activity-claims-table.ts and create-sync-review-table.ts, because `drizzle-kit push`
// needs a TTY and prompts create-vs-rename. See lib/db/schema.ts for what the ledger is for.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadEnvLocal() {
  try {
    const txt = readFileSync(join(process.cwd(), '.env.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* ok */ }
}

(async () => {
  loadEnvLocal();
  const { getDb } = await import('../lib/db');
  const { sql } = await import('drizzle-orm');
  const db = getDb();

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS zoom_appointment_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      appointment_id text NOT NULL,
      note_id text NOT NULL,
      meeting_uuid text,
      body_hash text NOT NULL,
      written_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS zoom_appointment_notes_uq
      ON zoom_appointment_notes (appointment_id)
  `);
  const r: any = await db.execute(sql`SELECT count(*) AS n FROM zoom_appointment_notes`);
  console.log('zoom_appointment_notes ready — rows:', ((r as any).rows ?? r)[0].n);
})().catch((e) => { console.error(e); process.exit(1); });
