// pages/readiness-map.tsx — Portfolio Advancement Map: every scored company on its readiness stage,
// against the stage it held at intake.
//
// THIS PAGE IS BUILT TO BE EMBEDDED IN A GHL DASHBOARD, and it needs no public route to do it:
//   - next.config.mjs already sends `frame-ancestors` for *.gohighlevel.com / *.leadconnectorhq.com /
//     *.msgsndr.com / *.leanrocketlab.org, and never X-Frame-Options: DENY.
//   - lib/security/staffSession.ts already sets the staff cookie SameSite=None; Secure, precisely so
//     it is sent inside a cross-site GHL iframe.
// So `/readiness-map?widget=1` drops straight into a GHL dashboard Embed widget and stays behind the
// default-deny middleware. A staff viewer who is not signed in gets the normal /staff-login redirect
// INSIDE the widget, signs in once, and holds the cookie for 30 days. Do not add a public variant.
//
// Three modes, in order of chrome: full app shell (default) -> ?embed=1 (GHL custom menu link, the
// Shell component's lean tab bar) -> ?widget=1 (no chrome at all, for a dashboard tile).

import { useEffect, useMemo, useRef, useState } from 'react';
import Shell from '@/components/shell/Shell';
import type { Portfolio, PortfolioRow, Scale } from '@/lib/stage/portfolio';

/* --------------------------------------------------------------------------
 * Scales, palettes, copy
 * ------------------------------------------------------------------------ */

interface ScaleDef { key: Scale; label: string; full: string; max: number; color: string; tick: (n: number) => string }

const SCALE_DEFS: ScaleDef[] = [
  { key: 'churchill', label: 'Churchill', full: 'Churchill stage of growth', max: 5, color: '#B98514', tick: (n) => `Stage ${n}` },
  { key: 'trl', label: 'TRL', full: 'Technology readiness', max: 9, color: '#05998C', tick: (n) => `TRL ${n}` },
  { key: 'mrl', label: 'MRL', full: 'Manufacturing readiness', max: 10, color: '#2a78d6', tick: (n) => `MRL ${n}` },
  { key: 'crl', label: 'CRL', full: 'Customer readiness', max: 9, color: '#d55181', tick: (n) => `CRL ${n}` },
];

// Status hues carry movement, never identity. Validated for colour-vision separation against a white
// surface (worst pair deltaE 10.3 deutan / 27.3 normal), so up and down never read alike.
const UP = '#05998C';
const FLAT = '#8A8A92';
const DOWN = '#D9534F';

// The intake form's `business_model` option keys are long sentences; these are the first 12
// characters, which is what the data layer hands over and is unique across the three.
const PATHS: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'All companies' },
  { id: 'developing_a', label: 'Product or technology' },
  { id: 'delivering_o', label: 'Service business' },
  { id: 'both_i_m_dev', label: 'Product and service' },
];
const pathLabel = (model: string | null) =>
  PATHS.find((p) => p.id !== 'all' && model?.startsWith(p.id))?.label ?? null;

type ViewKey = 'map' | 'move' | 'dist';
const VIEWS: Array<{ id: ViewKey; label: string }> = [
  { id: 'map', label: 'Stage map' },
  { id: 'move', label: 'Movement' },
  { id: 'dist', label: 'Intake vs today' },
];

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

const cur = (d: PortfolioRow, s: Scale) => d.scores[s].current;
const ini = (d: PortfolioRow, s: Scale) => d.scores[s].initial;
const deltaOf = (d: PortfolioRow, s: Scale) => {
  const a = ini(d, s), b = cur(d, s);
  return a == null || b == null ? null : b - a;
};
/** Colour by what the company DID, not by which scale it sits on. */
const statusColor = (d: PortfolioRow) =>
  d.snapshots < 2 ? FLAT : d.advanced > 0 ? UP : d.advanced < 0 ? DOWN : FLAT;

interface TipState { row: PortfolioRow; x: number; y: number }

/* --------------------------------------------------------------------------
 * Page
 * ------------------------------------------------------------------------ */

export default function ReadinessMapPage() {
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scaleKey, setScaleKey] = useState<Scale>('churchill');
  const [view, setView] = useState<ViewKey>('map');
  const [path, setPath] = useState('all');
  const [rescoredOnly, setRescoredOnly] = useState(false);
  const [tip, setTip] = useState<TipState | null>(null);
  const [widget, setWidget] = useState(false);
  const [width, setWidth] = useState(920);
  const plotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try { setWidget(new URLSearchParams(window.location.search).get('widget') === '1'); } catch { /* no-op */ }
  }, []);

  useEffect(() => {
    let live = true;
    fetch('/api/readiness/portfolio')
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Request failed (${r.status})`);
        return r.json();
      })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);

  // The SVGs are laid out in absolute units, so they need the real container width.
  useEffect(() => {
    const measure = () => { if (plotRef.current) setWidth(Math.max(560, plotRef.current.clientWidth - 16)); };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [data, view]);

  const scale = SCALE_DEFS.find((s) => s.key === scaleKey)!;

  const rows = useMemo(() => {
    if (!data) return [];
    return data.rows.filter(
      (d) =>
        cur(d, scaleKey) != null &&
        (path === 'all' || (d.businessModel ?? '').startsWith(path)) &&
        (!rescoredOnly || d.snapshots > 1),
    );
  }, [data, scaleKey, path, rescoredOnly]);

  const stats = useMemo(() => {
    if (!data) return null;
    const all = data.rows.filter((d) => path === 'all' || (d.businessModel ?? '').startsWith(path));
    const re = all.filter((d) => d.snapshots > 1);
    const moved = re.filter((d) => (deltaOf(d, scaleKey) ?? 0) !== 0);
    return {
      total: all.length,
      onScale: all.filter((d) => cur(d, scaleKey) != null).length,
      rescored: re.length,
      once: all.length - re.length,
      moved: moved.length,
      up: re.filter((d) => (deltaOf(d, scaleKey) ?? 0) > 0).length,
      down: re.filter((d) => (deltaOf(d, scaleKey) ?? 0) < 0).length,
    };
  }, [data, scaleKey, path]);

  const onEnter = (row: PortfolioRow) => (e: React.MouseEvent) => setTip({ row, x: e.clientX, y: e.clientY });
  const onMove = (e: React.MouseEvent) => setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t));
  const onLeave = () => setTip(null);
  const dotProps = (row: PortfolioRow) => ({
    onMouseEnter: onEnter(row), onMouseMove: onMove, onMouseLeave: onLeave, style: { cursor: 'pointer' as const },
  });

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!widget && (
        <header>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: '-0.01em' }}>
            Portfolio Advancement Map
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--text-secondary)', fontSize: 13, maxWidth: '62ch' }}>
            Every company Lean Rocket Lab has scored, placed on its readiness stage, with the stage it held at intake.
            Hover a dot for the company, its entry and current scores, and the stages it has moved.
          </p>
        </header>
      )}

      {error && (
        <div style={{ ...cardStyle, borderColor: '#f0c2c0', background: '#fdf3f2', color: '#8a2f2b', padding: 14, fontSize: 13 }}>
          Could not load the readiness data. {error}
        </div>
      )}

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <Kpi value={stats.total} label="Companies scored" note={`${data!.recordCount} stage records`} />
          <Kpi value={stats.onScale} label="On this scale" note={scale.full} />
          <Kpi value={stats.rescored} label="Rescored at least once" note={`${stats.once} still on one snapshot`} />
          <Kpi value={stats.moved} label="Changed stage" note={`${stats.up} up, ${stats.down} down`} />
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 14px', alignItems: 'center' }}>
        <Segmented
          label="Scale"
          options={SCALE_DEFS.map((s) => ({ id: s.key, label: s.label }))}
          value={scaleKey}
          accent={scale.color}
          onChange={(v) => setScaleKey(v as Scale)}
        />
        <Segmented
          label="View"
          options={VIEWS}
          value={view}
          accent={scale.color}
          onChange={(v) => setView(v as ViewKey)}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <span style={labelStyle}>Path</span>
          <select
            id="readiness-path"
            className="lrl-focus"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            style={{ fontSize: 12.5, padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius-control)', background: 'var(--surface)' }}
          >
            {PATHS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input id="readiness-rescored" type="checkbox" checked={rescoredOnly} onChange={(e) => setRescoredOnly(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
          Rescored only
        </label>
      </div>

      <section style={cardStyle}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: '6px 16px', padding: '12px 14px 8px' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, margin: 0 }}>
            {VIEWS.find((v) => v.id === view)!.label}
          </h2>
          <p style={{ margin: 0, fontSize: 11.5, color: 'var(--text-muted)' }}>
            {view === 'map' && `${rows.length} companies on ${scale.label}. A tail points back to the stage held at intake.`}
            {view === 'move' && 'Only companies scored more than once. The open dot is intake, the filled dot is today.'}
            {view === 'dist' && 'How many companies sat at each stage at intake against where they sit today.'}
          </p>
        </div>
        <Legend view={view} scaleColor={scale.color} />
        <div ref={plotRef} style={{ padding: '0 8px 10px', overflowX: 'auto' }}>
          {!data && !error && <Empty>Loading the portfolio from GoHighLevel...</Empty>}
          {data && rows.length === 0 && <Empty>No company matches these filters on the {scale.label} scale.</Empty>}
          {data && rows.length > 0 && view === 'map' && <StageMap rows={rows} scale={scale} width={width} dotProps={dotProps} />}
          {data && rows.length > 0 && view === 'move' && <Movement rows={rows} scale={scale} width={width} dotProps={dotProps} />}
          {data && rows.length > 0 && view === 'dist' && <Distribution rows={rows} scale={scale} width={width} />}
        </div>
      </section>

      {data && rows.length > 0 && !widget && <DataTable rows={rows} />}

      {tip && <Tooltip state={tip} />}
    </div>
  );

  if (widget) return <div style={{ padding: 12, background: 'var(--bg)', minHeight: '100%' }}>{body}</div>;
  return (
    <Shell active="readiness" breadcrumb="Readiness Map">
      <div style={{ padding: '18px 20px 40px' }}>{body}</div>
    </Shell>
  );
}

/* --------------------------------------------------------------------------
 * Views
 * ------------------------------------------------------------------------ */

type DotProps = (row: PortfolioRow) => Record<string, unknown>;

/**
 * Stage map: a lane per stage, companies packed into it as dots, and a hairline tail back to the
 * lane the company entered at. Packing rather than one row per company is what keeps 79 (and later
 * several hundred) companies inside a dashboard tile.
 */
function StageMap({ rows, scale, width, dotProps }: { rows: PortfolioRow[]; scale: ScaleDef; width: number; dotProps: DotProps }) {
  const padL = 14, padR = 14, padT = 14, padB = 40;
  const laneW = (width - padL - padR) / scale.max;
  const R = 5.5, STEP = 14, COLW = 15;

  const perLane: PortfolioRow[][] = [];
  for (let i = 1; i <= scale.max; i++) perLane.push(rows.filter((d) => cur(d, scale.key) === i));
  const maxCol = Math.max(1, Math.floor((laneW - 10) / COLW));
  const tallest = Math.max(1, ...perLane.map((a) => Math.ceil(a.length / maxCol)));
  const plotH = Math.max(76, tallest * STEP + 24);
  const height = plotH + padT + padB;
  const baseY = padT + plotH;
  const laneX = (i: number) => padL + laneW * (i - 0.5);

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${scale.full} stage map`}>
      {perLane.map((list, i) => (
        <g key={`axis-${i}`}>
          <line x1={laneX(i + 1)} x2={laneX(i + 1)} y1={padT} y2={baseY} stroke="var(--border)" />
          <text x={laneX(i + 1)} y={baseY + 18} textAnchor="middle" style={{ fontSize: 12.5, fontWeight: 600, fill: 'var(--text)' }}>{list.length}</text>
          <text x={laneX(i + 1)} y={baseY + 32} textAnchor="middle" style={{ fontSize: 11, fill: 'var(--text-muted)' }}>{scale.tick(i + 1)}</text>
        </g>
      ))}
      <line x1={padL} x2={width - padR} y1={baseY} y2={baseY} stroke="var(--border-strong)" />
      {perLane.map((list, li) => {
        const cols = Math.min(maxCol, Math.max(1, Math.ceil(list.length / tallest)));
        const sorted = list.slice().sort((a, b) => b.advanced - a.advanced || a.name.localeCompare(b.name));
        return sorted.map((d, idx) => {
          const cx = laneX(li + 1) + ((idx % cols) - (cols - 1) / 2) * COLW;
          const cy = baseY - 12 - Math.floor(idx / cols) * STEP;
          const start = ini(d, scale.key);
          const colour = statusColor(d);
          return (
            <g key={d.companyId + idx}>
              {start != null && start !== cur(d, scale.key) && (
                <>
                  <line x1={cx} y1={cy} x2={laneX(start)} y2={cy} stroke={colour} strokeWidth={1} opacity={0.5} />
                  <circle cx={laneX(start)} cy={cy} r={3.2} fill="var(--surface)" stroke={colour} strokeWidth={1.2} />
                </>
              )}
              <circle cx={cx} cy={cy} r={R} fill={colour} fillOpacity={d.snapshots > 1 ? 1 : 0.38} stroke="var(--surface)" strokeWidth={2} {...dotProps(d)} />
            </g>
          );
        });
      })}
    </svg>
  );
}

/** Movement: one row per rescored company, intake to today. The view for reading individual stories. */
function Movement({ rows, scale, width, dotProps }: { rows: PortfolioRow[]; scale: ScaleDef; width: number; dotProps: DotProps }) {
  const list = rows
    .filter((d) => d.snapshots > 1 && ini(d, scale.key) != null && cur(d, scale.key) != null)
    .sort((a, b) => (deltaOf(b, scale.key)! - deltaOf(a, scale.key)!) || a.name.localeCompare(b.name));
  if (!list.length) return <Empty>No rescored company has two {scale.label} scores yet.</Empty>;

  const padL = 190, padR = 44, padT = 24, padB = 12, ROW = 20;
  const height = padT + list.length * ROW + padB;
  const x = (v: number) => padL + ((v - 1) / (scale.max - 1)) * (width - padL - padR);

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${scale.label} movement by company`}>
      {Array.from({ length: scale.max }, (_, i) => i + 1).map((i) => (
        <g key={i}>
          <line x1={x(i)} x2={x(i)} y1={padT - 6} y2={height - padB} stroke="var(--border)" />
          <text x={x(i)} y={padT - 11} textAnchor="middle" style={{ fontSize: 11, fill: 'var(--text-muted)' }}>{i}</text>
        </g>
      ))}
      {list.map((d, i) => {
        const y = padT + i * ROW + ROW / 2;
        const a = ini(d, scale.key)!, b = cur(d, scale.key)!;
        const colour = statusColor(d);
        return (
          <g key={d.companyId}>
            <text x={padL - 12} y={y + 4} textAnchor="end" style={{ fontSize: 11.5, fill: 'var(--text-secondary)' }}>
              {d.name.length > 26 ? `${d.name.slice(0, 25)}…` : d.name}
            </text>
            {a !== b && <line x1={x(a)} x2={x(b)} y1={y} y2={y} stroke={colour} strokeWidth={2} />}
            <circle cx={x(a)} cy={y} r={4.5} fill="var(--surface)" stroke="var(--text-muted)" strokeWidth={1.5} {...dotProps(d)} />
            <circle cx={x(b)} cy={y} r={5.5} fill={colour} stroke="var(--surface)" strokeWidth={2} {...dotProps(d)} />
            <text x={width - padR + 8} y={y + 4} style={{ fontSize: 11, fill: b - a === 0 ? 'var(--text-muted)' : colour }}>
              {b - a > 0 ? `+${b - a}` : String(b - a)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Intake vs today: the portfolio-level shape, which is the version a funder reads. */
function Distribution({ rows, scale, width }: { rows: PortfolioRow[]; scale: ScaleDef; width: number }) {
  const padL = 18, padR = 18, padT = 16, padB = 44, height = 290;
  const laneW = (width - padL - padR) / scale.max;
  const withIntake = rows.filter((d) => ini(d, scale.key) != null);
  const at = Array.from({ length: scale.max }, (_, i) => withIntake.filter((d) => ini(d, scale.key) === i + 1).length);
  const now = Array.from({ length: scale.max }, (_, i) => rows.filter((d) => cur(d, scale.key) === i + 1).length);
  const mx = Math.max(1, ...at, ...now);
  const plotH = height - padT - padB;
  const baseY = padT + plotH;
  const bw = Math.min(26, laneW / 2.6);

  const bar = (v: number, cx: number, dx: number, fill: string, key: string) => {
    if (!v) return null;
    const h = (v / mx) * (plotH - 14);
    return (
      <g key={key}>
        <rect x={cx + dx - bw / 2} y={baseY - h} width={bw} height={h} fill={fill} rx={3} />
        <text x={cx + dx} y={baseY - h - 6} textAnchor="middle" style={{ fontSize: 11, fill: 'var(--text-secondary)' }}>{v}</text>
      </g>
    );
  };

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${scale.label} distribution at intake versus today`}>
      <line x1={padL} x2={width - padR} y1={baseY} y2={baseY} stroke="var(--border-strong)" />
      {Array.from({ length: scale.max }, (_, i) => {
        const cx = padL + laneW * (i + 0.5);
        return (
          <g key={i}>
            {bar(at[i], cx, -bw / 2 - 1, 'var(--gray-300)', `a${i}`)}
            {bar(now[i], cx, bw / 2 + 1, scale.color, `b${i}`)}
            <text x={cx} y={baseY + 18} textAnchor="middle" style={{ fontSize: 11, fill: 'var(--text-muted)' }}>{scale.tick(i + 1)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* --------------------------------------------------------------------------
 * Chrome
 * ------------------------------------------------------------------------ */

const cardStyle: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-card)', boxShadow: 'var(--shadow-xs)',
};
const labelStyle: React.CSSProperties = {
  fontSize: 10.5, letterSpacing: '0.09em', textTransform: 'uppercase',
  color: 'var(--text-muted)', fontWeight: 600,
};

function Kpi({ value, label, note }: { value: number; label: string; note: string }) {
  return (
    <div style={{ ...cardStyle, padding: '11px 13px' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ ...labelStyle, marginTop: 4 }}>{label}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>{note}</div>
    </div>
  );
}

function Segmented({ label, options, value, accent, onChange }: {
  label: string; options: Array<{ id: string; label: string }>; value: string; accent: string; onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={labelStyle}>{label}</span>
      <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 'var(--radius-control)', overflow: 'hidden' }} role="group" aria-label={label}>
        {options.map((o, i) => {
          const on = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              className="lrl-focus"
              aria-pressed={on}
              onClick={() => onChange(o.id)}
              style={{
                border: 0, borderLeft: i ? '1px solid var(--border)' : 0, cursor: 'pointer',
                font: 'inherit', fontSize: 12.5, padding: '5px 11px',
                background: on ? 'var(--gray-50)' : 'var(--surface)',
                color: on ? 'var(--text)' : 'var(--text-secondary)',
                fontWeight: on ? 600 : 400,
                boxShadow: on ? `inset 0 -2px 0 ${accent}` : 'none',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Legend({ view, scaleColor }: { view: ViewKey; scaleColor: string }) {
  const item = (colour: string, text: string, ring = false, faded = false) => (
    <span key={text} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-secondary)' }}>
      <i style={{
        width: 10, height: 10, borderRadius: '50%', display: 'block', flex: 'none',
        background: ring ? 'transparent' : colour, opacity: faded ? 0.38 : 1,
        border: ring ? '1.5px solid var(--text-muted)' : 'none',
      }} />
      {text}
    </span>
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', padding: '0 14px 10px' }}>
      {view === 'dist'
        ? [item('var(--gray-300)', 'At intake'), item(scaleColor, 'Today')]
        : [
            item(UP, 'Advanced'),
            item(FLAT, 'No change'),
            item(DOWN, 'Scored lower'),
            ...(view === 'map' ? [item(FLAT, 'Not yet rescored', false, true)] : []),
            item('', 'Where it started', true),
          ]}
    </div>
  );
}

function Tooltip({ state }: { state: TipState }) {
  const { row: d, x, y } = state;
  const moved = d.snapshots > 1;
  const advText = !moved ? 'Not yet rescored' : d.advanced > 0 ? `+${d.advanced} stages` : d.advanced < 0 ? `${d.advanced} stages` : 'No net change';
  const advColour = !moved ? 'var(--text-muted)' : d.advanced > 0 ? UP : d.advanced < 0 ? DOWN : FLAT;
  const line = (label: string, s: Scale) => {
    const a = ini(d, s), b = cur(d, s);
    if (a == null && b == null) return null;
    return (
      <tr key={s}>
        <th style={{ textAlign: 'left', ...labelStyle, padding: '1px 10px 1px 0' }}>{label}</th>
        <td style={tdStyle}>{a ?? '–'}</td>
        <td style={{ ...tdStyle, textAlign: 'center', width: 18, color: 'var(--text-muted)' }}>{'→'}</td>
        <td style={tdStyle}>{b ?? '–'}</td>
      </tr>
    );
  };
  return (
    <div
      role="tooltip"
      style={{
        position: 'fixed', zIndex: 60, pointerEvents: 'none', maxWidth: 290,
        left: Math.min(x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 300),
        top: Math.min(y + 14, (typeof window !== 'undefined' ? window.innerHeight : 800) - 210),
        background: 'var(--surface)', border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-control)', boxShadow: 'var(--shadow-lg)', padding: '10px 12px',
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}>{d.name}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 7 }}>{pathLabel(d.businessModel) ?? 'Path not set'}</div>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
        <tbody>
          <tr>
            <th />
            <td style={{ ...tdStyle, color: 'var(--text-muted)', fontSize: 10.5 }}>Intake</td>
            <td />
            <td style={{ ...tdStyle, color: 'var(--text-muted)', fontSize: 10.5 }}>Now</td>
          </tr>
          {line('Churchill', 'churchill')}
          {line('TRL', 'trl')}
          {line('MRL', 'mrl')}
          {line('CRL', 'crl')}
        </tbody>
      </table>
      <div style={{ marginTop: 8, paddingTop: 7, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11.5 }}>
        <span style={{ color: advColour }}>{advText}</span>
        <b style={{ fontVariantNumeric: 'tabular-nums' }}>{d.snapshots} snapshot{d.snapshots > 1 ? 's' : ''}</b>
      </div>
      <div style={{ marginTop: 3, display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11, color: 'var(--text-muted)' }}>
        <span>{d.firstDate}</span><span>{moved ? d.lastDate : ''}</span>
      </div>
    </div>
  );
}

const tdStyle: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', padding: '1px 0' };

function DataTable({ rows }: { rows: PortfolioRow[] }) {
  const pair = (s: ScorePairLike) => (s.initial == null && s.current == null ? '–' : `${s.initial ?? '–'} → ${s.current ?? '–'}`);
  return (
    <details style={cardStyle}>
      <summary style={{ cursor: 'pointer', padding: '10px 14px', fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>
        Open the underlying table
      </summary>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
          <thead>
            <tr>
              {['Company', 'Path', 'Churchill', 'TRL', 'MRL', 'CRL', 'Stages moved', 'Snapshots'].map((h, i) => (
                <th key={h} style={{ ...labelStyle, textAlign: i === 0 ? 'left' : 'right', padding: '6px 10px', borderTop: '1px solid var(--border)', background: 'var(--gray-50)', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice().sort((a, b) => b.advanced - a.advanced || a.name.localeCompare(b.name)).map((d) => (
              <tr key={d.companyId}>
                <td style={{ ...cellStyle, textAlign: 'left', minWidth: 170, whiteSpace: 'normal', color: 'var(--text)' }}>{d.name}</td>
                <td style={cellStyle}>{pathLabel(d.businessModel) ?? '–'}</td>
                <td style={cellStyle}>{pair(d.scores.churchill)}</td>
                <td style={cellStyle}>{pair(d.scores.trl)}</td>
                <td style={cellStyle}>{pair(d.scores.mrl)}</td>
                <td style={cellStyle}>{pair(d.scores.crl)}</td>
                <td style={cellStyle}>{d.snapshots > 1 ? (d.advanced > 0 ? `+${d.advanced}` : d.advanced) : '–'}</td>
                <td style={cellStyle}>{d.snapshots}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

interface ScorePairLike { initial: number | null; current: number | null }
const cellStyle: React.CSSProperties = {
  padding: '6px 10px', borderTop: '1px solid var(--border)', textAlign: 'right',
  whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)',
};

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '38px 14px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>{children}</div>;
}
