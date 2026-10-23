// scripts-ts/milestone-suggest.ts — READ-ONLY milestone suggester dry run. Writes NOTHING to GHL.
// Spec: docs/sprints/milestone-suggester.md (§7 step 1).
//
//   npx vite-node scripts-ts/milestone-suggest.ts --keys                    # run + grade all answer-key companies
//   npx vite-node scripts-ts/milestone-suggest.ts --company <id>[,<id>]     # any company (add --grade to grade a key company)
//   npx vite-node scripts-ts/milestone-suggest.ts --company <id> --contacts <id>,<id>   # override contact discovery
//
// Flags: --gather-only / --from-history (two-stage run)  --email-max N (default 40)  --no-email (skip source 4)  --email-days N (default 180)  --cap N (default 3 / MILESTONE_ACTIVE_CAP)
//        --dump-history (also write the exact text the model saw — review it for privacy before sharing)
// Emits reports/milestone-suggest-<stamp>.{json,md}. Needs GHL_* and ANTHROPIC_API_KEY in .env.local.
// There is deliberately no --apply. The write path is a separate build step (spec §7.4).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (n: string) => process.argv.includes(`--${n}`);

async function main() {
  loadEnvLocal();
  // Imports after env load: lib/ai/anthropic reads ANTHROPIC_API_KEY at module load.
  const { gatherCompanyHistory } = await import('../lib/milestones/gather');
  const { suggestMilestones, renderHistory } = await import('../lib/milestones/suggest');
  const { ANSWER_KEYS } = await import('../lib/milestones/answerKeys');
  const { evaluateAgainstKey } = await import('../lib/milestones/evaluate');

  const grading = flag('keys');
  const ids = grading ? ANSWER_KEYS.map((k) => k.companyId) : (arg('company') ?? '').split(',').filter(Boolean);
  if (!ids.length) { console.error('Pass --keys or --company <id>'); process.exit(1); }
  const cap = arg('cap') ? Number(arg('cap')) : undefined;
  const today = new Date().toISOString().slice(0, 10);

  const runs: any[] = [];
  let md = `# Milestone suggester dry run — ${today}\n\nRead-only. Nothing was written to GHL.\n`;
  for (const id of ids) {
    const t0 = Date.now();
    // Two-stage option, because each step must fit a short shell window: --gather-only saves the history,
    // --from-history reuses it (also makes prompt iteration cheap — no GHL reads).
    const histFile = `reports/milestone-history-${id}.json`;
    const history = flag('from-history')
      ? (JSON.parse(readFileSync(histFile, 'utf8')) as import('../lib/milestones/gather').CompanyHistory)
      : await gatherCompanyHistory(id, {
          includeEmail: !flag('no-email'),
          emailDays: arg('email-days') ? Number(arg('email-days')) : undefined,
          emailMax: arg('email-max') ? Number(arg('email-max')) : undefined,
          contactIds: arg('contacts')?.split(',').filter(Boolean),
        });
    if (flag('gather-only') || flag('save-history')) {
      mkdirSync('reports', { recursive: true });
      writeFileSync(histFile, JSON.stringify(history, null, 2));
      console.log(`saved ${histFile}: ${JSON.stringify(history.counts)}`);
      if (flag('gather-only')) continue;
    }
    const result = await suggestMilestones(history, { cap, today });
    const key = ANSWER_KEYS.find((k) => k.companyId === id);
    const evaluation = (grading || flag('grade')) && key ? await evaluateAgainstKey(key, result) : null;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);

    console.log(`\n=== ${history.companyName} (${id}) — ${secs}s`);
    console.log(`sources: ${JSON.stringify(history.counts)}; contacts ${history.contactIds.length}; existing milestones ${history.existing.length} (${result.activeCount} active)`);
    result.proposals.forEach((p, i) => console.log(`  P${i + 1} [${p.kind}] ${p.milestone}  (${p.category} · ${p.readinessDimension} · ${p.confidence}${p.inferred ? ' · inferred' : ''})`));
    result.alsoConsidered.forEach((p, i) => console.log(`  A${i + 1} [also] ${p.milestone}`));
    console.log(`  skipped: ${result.skipped.length}`);
    if (evaluation) {
      console.log(`  GRADE: recall ${(evaluation.recall * 100).toFixed(0)}% · violations ${evaluation.violations.length} · ${evaluation.pass ? 'PASS' : 'FAIL'}`);
      evaluation.matched.forEach((m) => console.log(`    ${m.keyId} → ${m.matchedTo ?? 'MISSED'}${m.placement === 'alsoConsidered' ? ' (also considered)' : ''}`));
      evaluation.violations.forEach((v) => console.log(`    VIOLATION ${v.mustSkip} ← ${v.proposal}`));
    }

    md += `\n## ${history.companyName}\n\nSources: ${history.counts.zoom_summary} Zoom summaries · ${history.counts.staff_note} staff notes · ${history.counts.activity} activities · ${history.counts.email} emails (of ${history.counts.emailsSeen} seen; ${history.counts.campaignFiltered} campaign blasts filtered). Existing milestones: ${history.existing.length} (${result.activeCount} active, cap ${result.cap}).\n`;
    const row = (p: any, ref: string) =>
      `| ${ref} | ${p.kind === 'completion' ? '✅ completion' : 'new'} | **${p.milestone}**<br>Done when: ${p.definitionOfDone} | ${p.category} · ${p.readinessDimension} | ${p.confidence}${p.inferred ? ', inferred' : ''}${p.targetDate ? ` · target ${p.targetDate}` : ''} | ${p.evidence.map((e: any) => `${e.date} ${e.source}: ${e.note}`).join('<br>')} |`;
    md += `\n### Proposed (under the cap)\n\n| # | Kind | Milestone | Category · Dim | Confidence | Evidence |\n|---|---|---|---|---|---|\n${result.proposals.map((p, i) => row(p, `P${i + 1}`)).join('\n') || '| — | | none | | | |'}\n`;
    md += `\n### Also considered (over the cap — never created)\n\n| # | Kind | Milestone | Category · Dim | Confidence | Evidence |\n|---|---|---|---|---|---|\n${result.alsoConsidered.map((p, i) => row(p, `A${i + 1}`)).join('\n') || '| — | | none | | | |'}\n`;
    md += `\n### Skipped\n\n${result.skipped.map((s) => `- **${s.candidate}** — ${s.rule}: ${s.reason}`).join('\n') || '- none'}\n`;
    if (evaluation) {
      md += `\n### Grade vs answer key — ${evaluation.pass ? '**PASS**' : '**FAIL**'} (recall ${(evaluation.recall * 100).toFixed(0)}%, ${evaluation.violations.length} violations)\n\n${evaluation.matched.map((m) => `- ${m.keyId} → ${m.matchedTo ?? '**MISSED**'}${m.placement === 'alsoConsidered' ? ' *(also considered)*' : ''} — ${m.why}`).join('\n')}\n${evaluation.violations.map((v) => `- ⚠️ VIOLATION: ${v.mustSkip} ← ${v.proposal}`).join('\n')}\n`;
    }
    runs.push({ companyId: id, history: { counts: history.counts, contactIds: history.contactIds, existing: history.existing, refs: history.items.map((i) => ({ ref: i.ref, date: i.date, source: i.source, title: i.title })) }, result, evaluation });
    if (flag('dump-history')) {
      mkdirSync('reports', { recursive: true });
      writeFileSync(`reports/milestone-history-${id}-${today}.txt`, renderHistory(history, today));
    }
  }

  mkdirSync('reports', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  writeFileSync(`reports/milestone-suggest-${stamp}.json`, JSON.stringify(runs, null, 2));
  writeFileSync(`reports/milestone-suggest-${stamp}.md`, md);
  console.log(`\nwrote reports/milestone-suggest-${stamp}.{json,md}`);
  if (grading) {
    const all = runs.every((r) => r.evaluation?.pass);
    console.log(all ? 'ALL ANSWER KEYS PASS' : 'ANSWER KEYS: NOT ALL PASS');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
