// vitest.config.ts — test discovery.
//
// WHY THIS FILE EXISTS: `_to_delete/` holds parked, untracked scrap (a scrapped client page) whose
// test imports a module that no longer exists. Vitest discovered it and reported a FAILED SUITE on
// every run — 637 tests passing next to one suite that cannot even load. That is worse than it
// sounds: a red run that is always red stops being a signal, and it masked a genuine failure long
// enough for me to push on the strength of a `grep` that only looked at the counts.
//
// The directory is deliberately not deleted — it is someone's parked work and it is untracked, so
// git never carried it. It is simply excluded from discovery.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '_to_delete/**',
    ],
  },
});
