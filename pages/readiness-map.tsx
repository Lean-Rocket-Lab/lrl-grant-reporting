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

interface ScaleDef { key: Scale; label: string; full: string; max: number; tick: (n: number) => string }

const SCALE_DEFS: ScaleDef[] = [
  { key: 'churchill', label: 'Churchill', full: 'Churchill stage of growth', max: 5, tick: (n) => `Stage ${n}` },
  { key: 'trl', label: 'TRL', full: 'Technology readiness', max: 9, tick: (n) => `TRL ${n}` },
  { key: 'mrl', label: 'MRL', full: 'Manufacturing readiness', max: 10, tick: (n) => `MRL ${n}` },
  { key: 'crl', label: 'CRL', full: 'Customer readiness', max: 9, tick: (n) => `CRL ${n}` },
];

/**
 * LRL brand kit, exact values. Gold is the ONE accent; charcoal carries structure and text.
 *
 * WHY THERE IS NO PER-SCALE COLOUR. The brand rule is one accent at a time, and an earlier draft
 * that gave each scale its own hue broke it. Dropping the four hues turned out to be the better
 * chart as well: only one scale is ever on screen, so a second hue was never carrying information.
 *
 * WHY MOVEMENT IS NOT COLOUR-CODED EITHER. Advanced / flat / regressed inside a single-accent
 * palette can only be gold, grey and red, and that trio FAILS the normal-vision separation floor
 * (gold vs grey deltaE 14.5, gold vs red 7.2 deutan) — full-colour readers cannot reliably tell
 * them apart, and secondary encoding does not excuse that. So direction is carried by POSITION
 * instead: the tail runs from where the company entered to where it sits now, and a tail pointing
 * left means it moved up the scale. Red appears only on a regression, and never alone — it always
 * sits with a minus sign or a tail that visibly runs backwards.
 *
 * Gold `#F8B82D` is 1.77:1 on white, which is fine for a BAR and far too weak for a 5px dot, so
 * marks use the deeper `GOLD_MARK` (3.73:1) and fills use brand gold.
 */
const GOLD = '#F8B82D';
const GOLD_MARK = '#A97D14';
const CHARCOAL = '#4A4A4A';
const INK = '#333333';
const SLATE = '#6E6E6E';
const GRAY_100 = '#F5F5F5';
const GRAY_300 = '#D9D9D9';
const RED = '#C0392B';

const DISPLAY = '"Montserrat", "Arial", sans-serif';
const BODY = '"Open Sans", "Segoe UI", "Arial", sans-serif';

/** Horizontal lockup, true ratio 350x91. Set WIDTH ONLY and let height follow: never both. */
const LOGO_SRC = '/brand/lrl-logo-horizontal-color.png';

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
/** Red is reserved for a regression, and never carries meaning on its own. Everything else is gold. */
const markColor = (d: PortfolioRow) => (d.snapshots > 1 && d.advanced < 0 ? RED : GOLD_MARK);

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
      <header
        style={{
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
          flexWrap: 'wrap', gap: '10px 20px',
          borderBottom: `3px solid ${GOLD}`, paddingBottom: widget ? 9 : 13,
        }}
      >
        <div>
          {/* Horizontal lockup, true ratio 350x91. Width is set, height follows: NEVER both. */}
          <img
            src={LOGO_SRC}
            alt="Lean Rocket Lab"
            width={widget ? 108 : 132}
            style={{ height: 'auto', display: 'block', marginBottom: widget ? 7 : 10 }}
          />
          <h1
            style={{
              fontFamily: DISPLAY, fontWeight: 700, color: CHARCOAL, margin: 0,
              fontSize: widget ? 17 : 23, lineHeight: 1.12, letterSpacing: '-0.005em',
            }}
          >
            Portfolio Advancement Map
          </h1>
          {!widget && (
            <p style={{ margin: '5px 0 0', color: SLATE, fontSize: 13, maxWidth: '62ch' }}>
              Every company Lean Rocket Lab has scored, placed on its readiness stage, with the stage it held at
              intake. Hover a dot for the company, its entry and current scores, and the stages it has moved.
            </p>
          )}
        </div>
        <p style={{ margin: 0, ...labelStyle, paddingBottom: 2 }}>
          Client readiness{data ? ` \u00b7 ${data.rows.length} companies` : ''}
        </p>
      </header>

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
          accent={GOLD}
          onChange={(v) => setScaleKey(v as Scale)}
        />
        <Segmented
          label="View"
          options={VIEWS}
          value={view}
          accent={GOLD}
          onChange={(v) => setView(v as ViewKey)}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <span style={labelStyle}>Path</span>
          <select
            id="readiness-path"
            className="lrl-focus"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            style={{ fontSize: 12.5, padding: '5px 8px', border: `1px solid ${GRAY_300}`, borderRadius: 4, background: '#FFFFFF' }}
          >
            {PATHS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: SLATE, cursor: 'pointer' }}>
          <input id="readiness-rescored" type="checkbox" checked={rescoredOnly} onChange={(e) => setRescoredOnly(e.target.checked)} style={{ accentColor: GOLD }} />
          Rescored only
        </label>
      </div>

      <section style={cardStyle}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: '6px 16px', padding: '12px 14px 8px' }}>
          <h2 style={{ fontFamily: DISPLAY, fontSize: 14, fontWeight: 700, color: CHARCOAL, margin: 0 }}>
            {VIEWS.find((v) => v.id === view)!.label}
          </h2>
          <p style={{ margin: 0, fontSize: 11.5, color: SLATE }}>
            {view === 'map' && `${rows.length} companies on ${scale.label}. A tail points back to the stage held at intake.`}
            {view === 'move' && 'Only companies scored more than once. The open dot is intake, the filled dot is today.'}
            {view === 'dist' && 'How many companies sat at each stage at intake against where they sit today.'}
          </p>
        </div>
        <Legend view={view} />
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

  if (widget) return <div style={{ padding: 14, background: '#FFFFFF', minHeight: '100%', fontFamily: BODY, color: INK }}>{body}</div>;
  return (
    <Shell active="readiness" breadcrumb="Readiness Map">
      <div style={{ padding: '18px 20px 40px', fontFamily: BODY, color: INK }}>{body}</div>
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
          <line x1={laneX(i + 1)} x2={laneX(i + 1)} y1={padT} y2={baseY} stroke={GRAY_300} />
          <text x={laneX(i + 1)} y={baseY + 18} textAnchor="middle" style={{ fontSize: 12.5, fontWeight: 600, fill: INK }}>{list.length}</text>
          <text x={laneX(i + 1)} y={baseY + 32} textAnchor="middle" style={{ fontSize: 11, fill: SLATE }}>{scale.tick(i + 1)}</text>
        </g>
      ))}
      <line x1={padL} x2={width - padR} y1={baseY} y2={baseY} stroke={CHARCOAL} />
      {perLane.map((list, li) => {
        const cols = Math.min(maxCol, Math.max(1, Math.ceil(list.length / tallest)));
        const sorted = list.slice().sort((a, b) => b.advanced - a.advanced || a.name.localeCompare(b.name));
        return sorted.map((d, idx) => {
          const cx = laneX(li + 1) + ((idx % cols) - (cols - 1) / 2) * COLW;
          const cy = baseY - 12 - Math.floor(idx / cols) * STEP;
          const start = ini(d, scale.key);
          const colour = markColor(d);
          return (
            <g key={d.companyId + idx}>
              {start != null && start !== cur(d, scale.key) && (
                <>
                  <line x1={cx} y1={cy} x2={laneX(start)} y2={cy} stroke={colour} strokeWidth={1} opacity={0.5} />
                  <circle cx={laneX(start)} cy={cy} r={3.2} fill="#FFFFFF" stroke={colour} strokeWidth={1.2} />
                </>
              )}
              <circle cx={cx} cy={cy} r={R} fill={colour} fillOpacity={d.snapshots > 1 ? 1 : 0.38} stroke="#FFFFFF" strokeWidth={2} {...dotProps(d)} />
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
          <line x1={x(i)} x2={x(i)} y1={padT - 6} y2={height - padB} stroke={GRAY_300} />
          <text x={x(i)} y={padT - 11} textAnchor="middle" style={{ fontSize: 11, fill: SLATE }}>{i}</text>
        </g>
      ))}
      {list.map((d, i) => {
        const y = padT + i * ROW + ROW / 2;
        const a = ini(d, scale.key)!, b = cur(d, scale.key)!;
        const colour = markColor(d);
        return (
          <g key={d.companyId}>
            <text x={padL - 12} y={y + 4} textAnchor="end" style={{ fontSize: 11.5, fill: SLATE }}>
              {d.name.length > 26 ? `${d.name.slice(0, 25)}…` : d.name}
            </text>
            {a !== b && <line x1={x(a)} x2={x(b)} y1={y} y2={y} stroke={colour} strokeWidth={2} />}
            <circle cx={x(a)} cy={y} r={4.5} fill="#FFFFFF" stroke={SLATE} strokeWidth={1.5} {...dotProps(d)} />
            <circle cx={x(b)} cy={y} r={5.5} fill={colour} stroke="#FFFFFF" strokeWidth={2} {...dotProps(d)} />
            <text x={width - padR + 8} y={y + 4} style={{ fontSize: 11, fontWeight: 600, fill: b - a === 0 ? SLATE : b - a < 0 ? RED : INK }}>
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
        <text x={cx + dx} y={baseY - h - 6} textAnchor="middle" style={{ fontSize: 11, fill: SLATE }}>{v}</text>
      </g>
    );
  };

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${scale.label} distribution at intake versus today`}>
      <line x1={padL} x2={width - padR} y1={baseY} y2={baseY} stroke={CHARCOAL} />
      {Array.from({ length: scale.max }, (_, i) => {
        const cx = padL + laneW * (i + 0.5);
        return (
          <g key={i}>
            {bar(at[i], cx, -bw / 2 - 1, GRAY_300, `a${i}`)}
            {bar(now[i], cx, bw / 2 + 1, GOLD, `b${i}`)}
            <text x={cx} y={baseY + 18} textAnchor="middle" style={{ fontSize: 11, fill: SLATE }}>{scale.tick(i + 1)}</text>
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
  background: '#FFFFFF', border: `1px solid ${GRAY_300}`,
  borderRadius: 6, boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
};
const labelStyle: React.CSSProperties = {
  fontFamily: BODY, fontSize: 10.5, letterSpacing: '0.11em', textTransform: 'uppercase',
  color: SLATE, fontWeight: 600,
};

function Kpi({ value, label, note }: { value: number; label: string; note: string }) {
  return (
    <div style={{ ...cardStyle, padding: '11px 13px', borderTop: `2px solid ${GOLD}` }}>
      <div style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 700, color: CHARCOAL, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ ...labelStyle, marginTop: 4 }}>{label}</div>
      <div style={{ fontSize: 11.5, color: SLATE, marginTop: 2 }}>{note}</div>
    </div>
  );
}

function Segmented({ label, options, value, accent, onChange }: {
  label: string; options: Array<{ id: string; label: string }>; value: string; accent: string; onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={labelStyle}>{label}</span>
      <div style={{ display: 'flex', border: `1px solid ${GRAY_300}`, borderRadius: 4, overflow: 'hidden' }} role="group" aria-label={label}>
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
                border: 0, borderLeft: i ? `1px solid ${GRAY_300}` : 0, cursor: 'pointer',
                font: 'inherit', fontSize: 12.5, padding: '5px 11px',
                background: on ? GRAY_100 : '#FFFFFF',
                color: on ? INK : SLATE,
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

function Legend({ view }: { view: ViewKey }) {
  const chip = (text: string, node: React.ReactNode) => (
    <span key={text} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: SLATE }}>
      {node}{text}
    </span>
  );
  const disc = (fill: string, opacity = 1) => (
    <i style={{ width: 10, height: 10, borderRadius: '50%', display: 'block', flex: 'none', background: fill, opacity }} />
  );
  const ring = <i style={{ width: 10, height: 10, borderRadius: '50%', display: 'block', flex: 'none', border: `1.5px solid ${CHARCOAL}` }} />;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', padding: '0 14px 10px' }}>
      {view === 'dist'
        ? [chip('At intake', disc(GRAY_300)), chip('Today', disc(GOLD))]
        : [
            chip('Where it sits today', disc(GOLD_MARK)),
            ...(view === 'map' ? [chip('Not yet rescored', disc(GOLD_MARK, 0.38))] : []),
            chip('Where it started', ring),
            chip('Scored lower than at intake', disc(RED)),
          ]}
    </div>
  );
}

function Tooltip({ state }: { state: TipState }) {
  const { row: d, x, y } = state;
  const moved = d.snapshots > 1;
  const advText = !moved ? 'Not yet rescored' : d.advanced > 0 ? `+${d.advanced} stages` : d.advanced < 0 ? `${d.advanced} stages` : 'No net change';
  const advColour = d.advanced < 0 ? RED : moved ? INK : SLATE;
  const line = (label: string, s: Scale) => {
    const a = ini(d, s), b = cur(d, s);
    if (a == null && b == null) return null;
    return (
      <tr key={s}>
        <th style={{ textAlign: 'left', ...labelStyle, padding: '1px 10px 1px 0' }}>{label}</th>
        <td style={tdStyle}>{a ?? '–'}</td>
        <td style={{ ...tdStyle, textAlign: 'center', width: 18, color: SLATE }}>{'→'}</td>
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
        background: '#FFFFFF', border: `1px solid ${GRAY_300}`,
        borderRadius: 4, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: '10px 12px',
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}>{d.name}</div>
      <div style={{ fontSize: 11, color: SLATE, marginBottom: 7 }}>{pathLabel(d.businessModel) ?? 'Path not set'}</div>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11.5 }}>
        <tbody>
          <tr>
            <th />
            <td style={{ ...tdStyle, color: SLATE, fontSize: 10.5 }}>Intake</td>
            <td />
            <td style={{ ...tdStyle, color: SLATE, fontSize: 10.5 }}>Now</td>
          </tr>
          {line('Churchill', 'churchill')}
          {line('TRL', 'trl')}
          {line('MRL', 'mrl')}
          {line('CRL', 'crl')}
        </tbody>
      </table>
      <div style={{ marginTop: 8, paddingTop: 7, borderTop: `1px solid ${GRAY_300}`, display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11.5 }}>
        <span style={{ color: advColour }}>{advText}</span>
        <b style={{ fontVariantNumeric: 'tabular-nums' }}>{d.snapshots} snapshot{d.snapshots > 1 ? 's' : ''}</b>
      </div>
      <div style={{ marginTop: 3, display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 11, color: SLATE }}>
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
      <summary style={{ cursor: 'pointer', padding: '10px 14px', fontSize: 12.5, fontWeight: 600, color: SLATE }}>
        Open the underlying table
      </summary>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
          <thead>
            <tr>
              {['Company', 'Path', 'Churchill', 'TRL', 'MRL', 'CRL', 'Stages moved', 'Snapshots'].map((h, i) => (
                <th key={h} style={{ ...labelStyle, textAlign: i === 0 ? 'left' : 'right', padding: '6px 10px', borderTop: `1px solid ${GRAY_300}`, background: GRAY_100, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice().sort((a, b) => b.advanced - a.advanced || a.name.localeCompare(b.name)).map((d) => (
              <tr key={d.companyId}>
                <td style={{ ...cellStyle, textAlign: 'left', minWidth: 170, whiteSpace: 'normal', color: INK }}>{d.name}</td>
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
  padding: '6px 10px', borderTop: `1px solid ${GRAY_300}`, textAlign: 'right',
  whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: SLATE,
};

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '38px 14px', textAlign: 'center', color: SLATE, fontSize: 13 }}>{children}</div>;
}
