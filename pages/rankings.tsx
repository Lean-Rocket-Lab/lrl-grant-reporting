// pages/rankings.tsx — drag-and-drop page ranking for Profiles.
//
// Zach reorders who appears first on each website page; Save writes the `rank_*` field for that page
// on GHL Profiles (lib/rankings/placements.ts is the page table). The live site already sorts by these
// fields: lower = first, blank = after all ranked items, alphabetical.
//
// Native HTML5 drag-and-drop, with up/down/add/remove buttons on every row as the keyboard and touch
// fallback. Edits are held per list (placement + People/Resources) until Save; Save posts each dirty
// list and the page takes the stored ranks from the response — NOT from a re-fetch, because the object
// search lags writes by ~12 s and would show the old order.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Shell from '@/components/shell/Shell';
import type { Placement, ProfileType } from '@/lib/rankings/placements';
import type { RankingRow } from '@/lib/rankings/service';
import type { SaveResult } from '@/lib/rankings/service';

const PUBLISHED = ['published'];
const WITH_UNPUBLISHED = ['published', 'approved', 'pending'];

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-sm)' };
const eyebrow: React.CSSProperties = { fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--brand)' };
const primaryBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 15px', borderRadius: 8, border: 'none', background: 'var(--brand)', color: 'var(--ink-900)', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 8, border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text-secondary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-body)' };
const iconBtn: React.CSSProperties = { width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 };
const pill = (on: boolean): React.CSSProperties => ({
  padding: '7px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-body)',
  border: `1px solid ${on ? 'var(--ink-900)' : 'var(--border-strong)'}`, background: on ? 'var(--ink-900)' : 'var(--surface)', color: on ? '#fff' : 'var(--text-secondary)',
});

const listKey = (field: string, type: ProfileType) => `${field}|${type}`;
const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const byName = (a: RankingRow, b: RankingRow) => a.name.localeCompare(b.name);

function inScope(p: RankingRow, pl: Placement, type: ProfileType, statuses: string[]) {
  const m = pl.membership;
  return p.profileType === type && !!p.profileStatus && statuses.includes(p.profileStatus) && (!m || p[m.field].includes(m.value));
}

export default function RankingsPage() {
  const router = useRouter();
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [profiles, setProfiles] = useState<RankingRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [field, setField] = useState('rank_our_team');
  const [type, setType] = useState<ProfileType>('person');
  const [showUnpublished, setShowUnpublished] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<{ text: string; problems: string[] } | null>(null);
  const dragId = useRef<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/rankings')
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        setPlacements(j.placements);
        setProfiles(j.profiles);
      })
      .catch((e) => setLoadError(String(e?.message ?? e)));
  }, []);

  // A drag dropped outside both columns must not leave the insertion line behind.
  useEffect(() => {
    const end = () => { dragId.current = null; setDropAt(null); };
    window.addEventListener('dragend', end);
    return () => window.removeEventListener('dragend', end);
  }, []);

  const statuses = showUnpublished ? WITH_UNPUBLISHED : PUBLISHED;
  const placement = placements.find((p) => p.field === field);
  const byId = useMemo(() => new Map((profiles ?? []).map((p) => [p.id, p])), [profiles]);

  /** The stored order of one list: ranked profiles by rank (ties by name). */
  const storedOrder = useCallback(
    (pl: Placement, t: ProfileType) =>
      (profiles ?? [])
        .filter((p) => inScope(p, pl, t, statuses) && p.ranks[pl.field] != null)
        .sort((a, b) => (a.ranks[pl.field]! - b.ranks[pl.field]!) || byName(a, b))
        .map((p) => p.id),
    [profiles, statuses],
  );

  const dirtyKeys = useMemo(
    () =>
      Object.entries(drafts)
        .filter(([k, order]) => {
          const [f, t] = k.split('|') as [string, ProfileType];
          const pl = placements.find((p) => p.field === f);
          return pl && !sameOrder(order, storedOrder(pl, t));
        })
        .map(([k]) => k),
    [drafts, placements, storedOrder],
  );
  const dirty = dirtyKeys.length > 0;

  // Warn before leaving with unsaved changes — tab close and in-app navigation both.
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    const onRoute = () => {
      if (!window.confirm('You have unsaved ranking changes. Leave without saving?')) {
        router.events.emit('routeChangeError');
        throw 'Route change aborted (unsaved rankings)';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    router.events.on('routeChangeStart', onRoute);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      router.events.off('routeChangeStart', onRoute);
    };
  }, [dirty, router]);

  const key = listKey(field, type);
  const ranked: string[] = placement ? drafts[key] ?? storedOrder(placement, type) : [];
  const rankedSet = new Set(ranked);
  const unranked = placement
    ? (profiles ?? []).filter((p) => inScope(p, placement, type, statuses) && !rankedSet.has(p.id)).sort(byName)
    : [];

  const setRanked = (next: string[]) => { setSummary(null); setDrafts((d) => ({ ...d, [key]: next })); };
  const move = (id: string, to: number) => {
    const next = ranked.filter((x) => x !== id);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
    setRanked(next);
  };
  const remove = (id: string) => setRanked(ranked.filter((x) => x !== id));

  const pickPlacement = (f: string) => {
    setField(f);
    const pl = placements.find((p) => p.field === f);
    if (pl && !pl.types.includes(type)) setType(pl.types[0]);
  };

  async function save() {
    if (!placements.length || !dirty) return;
    setSaving(true);
    setSummary(null);
    let updated = 0, cleared = 0, unchanged = 0;
    const problems: string[] = [];
    const nextProfiles = new Map(byId);
    const nextDrafts = { ...drafts };
    for (const k of dirtyKeys) {
      const [f, t] = k.split('|') as [string, ProfileType];
      const pl = placements.find((p) => p.field === f)!;
      const baseline: Record<string, number | null> = {};
      for (const p of profiles ?? []) if (inScope(p, pl, t, statuses)) baseline[p.id] = p.ranks[f] ?? null;
      try {
        const r = await fetch('/api/rankings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: f, type: t, orderedIds: drafts[k], statuses, baseline }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        const res = j as SaveResult;
        updated += res.updated.length;
        cleared += res.cleared.length;
        unchanged += res.unchanged.length;
        for (const s of res.skipped) problems.push(`${pl.label}: ${byId.get(s.id)?.name ?? s.id} — ${s.reason}`);
        for (const [id, value] of Object.entries(res.ranks)) {
          const p = nextProfiles.get(id);
          if (p) nextProfiles.set(id, { ...p, ranks: { ...p.ranks, [f]: value } });
        }
        if (!res.skipped.length) delete nextDrafts[k];
      } catch (e: any) {
        problems.push(`${pl.label} (${t === 'person' ? 'People' : 'Resources'}): ${e?.message ?? e}`);
      }
    }
    setProfiles((profiles ?? []).map((p) => nextProfiles.get(p.id) ?? p));
    setDrafts(nextDrafts);
    setSummary({ text: `${updated} updated, ${cleared} cleared, ${unchanged} unchanged${problems.length ? `, ${problems.length} problem${problems.length > 1 ? 's' : ''}` : ''}`, problems });
    setSaving(false);
  }

  const onDropRanked = (index: number) => {
    const id = dragId.current;
    dragId.current = null;
    setDropAt(null);
    if (id) move(id, index > ranked.indexOf(id) && ranked.includes(id) ? index - 1 : index);
  };

  return (
    <Shell active="rankings" breadcrumb="Rankings" env="live">
      <div style={{ padding: '26px 30px', maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ marginBottom: 16, display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 420px' }}>
            <span style={eyebrow}>Website order</span>
            <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 27, letterSpacing: '-.02em', margin: '7px 0 6px', color: 'var(--text)' }}>Rankings</h1>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--gray-500)', maxWidth: '76ch' }}>
              Drag profiles into the order they should appear on each page. Lower numbers show first; unranked profiles follow alphabetically.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {dirty && <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--yellow-700)' }}><i className="fa-solid fa-circle" style={{ fontSize: 8, marginRight: 6 }} />Unsaved changes ({dirtyKeys.length} list{dirtyKeys.length > 1 ? 's' : ''})</span>}
            {dirty && <button style={ghostBtn} disabled={saving} onClick={() => { setDrafts({}); setSummary(null); }}>Discard</button>}
            <button style={{ ...primaryBtn, opacity: dirty && !saving ? 1 : 0.5, cursor: dirty && !saving ? 'pointer' : 'default' }} disabled={!dirty || saving} onClick={save}>
              <i className={`fa-solid ${saving ? 'fa-spinner fa-spin' : 'fa-floppy-disk'}`} /> {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {summary && (
          <div style={{ ...card, padding: '10px 14px', marginBottom: 14, fontSize: 13, borderColor: summary.problems.length ? '#e5a3a3' : 'var(--teal-200)', background: summary.problems.length ? '#fdf2f2' : 'var(--accent-tint)' }}>
            <strong>Saved:</strong> {summary.text}
            {summary.problems.map((p) => <div key={p} style={{ marginTop: 4, color: '#9b2c2c' }}>{p}</div>)}
          </div>
        )}

        {loadError && <div style={{ ...card, padding: 14, color: '#9b2c2c' }}>Could not load profiles: {loadError}</div>}
        {!profiles && !loadError && <div style={{ ...card, padding: 14, color: 'var(--gray-500)' }}><i className="fa-solid fa-spinner fa-spin" /> Loading profiles…</div>}

        {profiles && placement && (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {placements.map((p) => {
                const isDirty = dirtyKeys.some((k) => k.startsWith(`${p.field}|`));
                return (
                  <button key={p.field} style={pill(p.field === field)} onClick={() => pickPlacement(p.field)}>
                    {p.label}{isDirty && <span style={{ color: 'var(--brand)', marginLeft: 5 }}>●</span>}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
              {placement.types.length > 1 && (
                <div style={{ display: 'inline-flex', border: '1px solid var(--border-strong)', borderRadius: 8, overflow: 'hidden' }}>
                  {placement.types.map((t) => (
                    <button key={t} onClick={() => setType(t)} style={{ padding: '7px 14px', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-body)', background: t === type ? 'var(--brand)' : 'var(--surface)', color: t === type ? 'var(--ink-900)' : 'var(--text-secondary)' }}>
                      {t === 'person' ? 'People' : 'Resources'}
                    </button>
                  ))}
                </div>
              )}
              <label style={{ fontSize: 13, color: dirty ? 'var(--gray-400)' : 'var(--text-secondary)', display: 'inline-flex', gap: 6, alignItems: 'center' }} title={dirty ? 'Save or discard first' : undefined}>
                <input type="checkbox" checked={showUnpublished} disabled={dirty} onChange={(e) => setShowUnpublished(e.target.checked)} />
                Include approved &amp; pending
              </label>
              <span style={{ fontSize: 12, color: 'var(--gray-500)' }}>Field <code style={{ fontFamily: 'var(--font-mono)' }}>{placement.field}</code></span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
              <section
                style={{ ...card, padding: 12 }}
                onDragOver={(e) => { e.preventDefault(); if (dropAt == null) setDropAt(ranked.length); }}
                onDrop={(e) => { e.preventDefault(); onDropRanked(dropAt ?? ranked.length); }}
              >
                <h2 style={colHead}>Ranked <span style={countTag}>{ranked.length}</span></h2>
                {ranked.length === 0 && <div style={emptyNote}>Drag profiles here, or click Add.</div>}
                {ranked.map((id, i) => {
                  const p = byId.get(id);
                  if (!p) return null;
                  const stored = p.ranks[field];
                  return (
                    <div key={id}>
                      {dropAt === i && <div style={dropLine} />}
                      <Row
                        p={p}
                        badge={i + 1}
                        hint={stored !== i + 1 ? (stored == null ? 'new' : `was ${stored}`) : null}
                        onDragStart={() => { dragId.current = id; }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const r = e.currentTarget.getBoundingClientRect();
                          setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
                        }}
                      >
                        <button style={iconBtn} aria-label={`Move ${p.name} up`} disabled={i === 0} onClick={() => move(id, i - 1)}><i className="fa-solid fa-arrow-up" /></button>
                        <button style={iconBtn} aria-label={`Move ${p.name} down`} disabled={i === ranked.length - 1} onClick={() => move(id, i + 1)}><i className="fa-solid fa-arrow-down" /></button>
                        <button style={{ ...iconBtn, width: 'auto', padding: '0 9px' }} aria-label={`Remove ${p.name} from ranking`} onClick={() => remove(id)}>Remove</button>
                      </Row>
                    </div>
                  );
                })}
                {dropAt === ranked.length && ranked.length > 0 && <div style={dropLine} />}
              </section>

              <section
                style={{ ...card, padding: 12, background: 'var(--surface-subtle)' }}
                onDragOver={(e) => { e.preventDefault(); setDropAt(null); }}
                onDrop={(e) => { e.preventDefault(); const id = dragId.current; dragId.current = null; if (id && rankedSet.has(id)) remove(id); }}
              >
                <h2 style={colHead}>Unranked <span style={countTag}>{unranked.length}</span></h2>
                {unranked.length === 0 && <div style={emptyNote}>Everyone on this page is ranked.</div>}
                {unranked.map((p) => (
                  <Row key={p.id} p={p} badge={null} hint={null} onDragStart={() => { dragId.current = p.id; }}>
                    <button style={{ ...iconBtn, width: 'auto', padding: '0 9px' }} aria-label={`Add ${p.name} to ranking`} onClick={() => setRanked([...ranked, p.id])}>Add</button>
                  </Row>
                ))}
              </section>
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}

const colHead: React.CSSProperties = { fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, margin: '2px 4px 10px', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8 };
const countTag: React.CSSProperties = { fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'var(--gray-100)', color: 'var(--gray-500)' };
const emptyNote: React.CSSProperties = { fontSize: 13, color: 'var(--gray-500)', padding: '18px 8px', textAlign: 'center', border: '1px dashed var(--border-strong)', borderRadius: 10 };
const dropLine: React.CSSProperties = { height: 3, borderRadius: 2, background: 'var(--brand)', margin: '2px 0' };

function Row(props: {
  p: RankingRow;
  badge: number | null;
  hint: string | null;
  onDragStart: () => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}) {
  const { p, badge, hint } = props;
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.id); props.onDragStart(); }}
      onDragOver={props.onDragOver}
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', marginBottom: 6, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'grab' }}
    >
      <span style={{ width: 26, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13, color: badge ? 'var(--ink-900)' : 'var(--gray-300)' }}>{badge ?? '–'}</span>
      {p.thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.thumb} alt="" width={34} height={34} style={{ borderRadius: p.profileType === 'person' ? '50%' : 6, objectFit: p.profileType === 'person' ? 'cover' : 'contain', background: 'var(--gray-50)', flex: '0 0 34px' }} />
      ) : (
        <span style={{ width: 34, height: 34, flex: '0 0 34px', borderRadius: p.profileType === 'person' ? '50%' : 6, background: 'var(--gray-100)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gray-400)' }}>
          <i className={`fa-solid ${p.profileType === 'person' ? 'fa-user' : 'fa-building'}`} />
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.name}
          {p.profileStatus !== 'published' && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: 'var(--yellow-700)' }}>{p.profileStatus}</span>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--gray-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.subtitle ?? ' '}
          {hint && <span style={{ marginLeft: 6, color: 'var(--teal-700)', fontWeight: 600 }}>· {hint}</span>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>{props.children}</div>
    </div>
  );
}
