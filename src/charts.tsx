// Small SVG charts for the Progress screen. Colors validated for the dark card
// surface (#1b1f25) with the dataviz palette checker: blue for e1RM, amber for TM.

import { useState } from 'preact/hooks';

export const C_E1RM = '#3987e5';
export const C_TM = '#c98500';
const GRID = '#2a3039';
const INK_MUTED = '#8b95a1';
const SURFACE = '#1b1f25';

const W = 360, H = 190, L = 34, R = 40, T = 10, B = 22;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const t = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

function niceTicks(lo: number, hi: number, n = 4): number[] {
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

export interface Point { date: string; value: number; pr?: boolean; label?: string }

/**
 * e1RM per AMRAP as a line (PRs dotted) with the training max as a step line.
 * Tap or drag anywhere for the values at that date.
 */
export function ProgressChart({ points, steps, unit = 'kg' }: { points: Point[]; steps: Point[]; unit?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <p class="muted">Not enough AMRAPs to chart yet.</p>;
  const x0 = t(points[0].date), x1 = t(points[points.length - 1].date);
  const stepsIn = steps.filter((s) => t(s.date) <= x1);
  const vals = [...points.map((p) => p.value), ...stepsIn.map((s) => s.value)];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || 5;
  lo -= pad; hi += pad;
  const X = (iso: string) => L + ((t(iso) - x0) / (x1 - x0 || 1)) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.date).toFixed(1)},${Y(p.value).toFixed(1)}`).join('');
  // TM: flat from each cycle's start to the next one's.
  let tmPath = '';
  const tmAt = (iso: string) => [...steps].reverse().find((s) => s.date <= iso)?.value ?? null;
  stepsIn.forEach((s, i) => {
    const from = Math.max(t(s.date), x0);
    const next = stepsIn[i + 1];
    const to = next ? t(next.date) : x1;
    const xa = L + ((from - x0) / (x1 - x0 || 1)) * (W - L - R), xb = L + ((to - x0) / (x1 - x0 || 1)) * (W - L - R);
    tmPath += `${tmPath ? 'L' : 'M'}${xa.toFixed(1)},${Y(s.value).toFixed(1)}H${xb.toFixed(1)}`;
  });

  const yTicks = niceTicks(lo, hi);
  const xTicks: { x: number; label: string }[] = [];
  const d0 = new Date(x0), d1 = new Date(x1);
  const spanMonths = (d1.getUTCFullYear() - d0.getUTCFullYear()) * 12 + d1.getUTCMonth() - d0.getUTCMonth();
  const every = spanMonths > 18 ? 6 : spanMonths > 8 ? 3 : 1;
  for (let m = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1)); m.getTime() <= x1; m.setUTCMonth(m.getUTCMonth() + 1)) {
    if (m.getUTCMonth() % every) continue;
    const x = L + ((m.getTime() - x0) / (x1 - x0)) * (W - L - R);
    xTicks.push({ x, label: m.getUTCMonth() === 0 || every === 1 ? `${MONTHS[m.getUTCMonth()]} ${String(m.getUTCFullYear()).slice(2)}` : MONTHS[m.getUTCMonth()] });
  }

  const last = points[points.length - 1];
  const h = hover != null ? points[hover] : null;
  const onMove = (e: PointerEvent) => {
    const svg = e.currentTarget as SVGSVGElement;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(X(p.date) - px) < Math.abs(X(points[best].date) - px)) best = i; });
    setHover(best);
  };

  return (
    <div class="chart">
      <div class="legend">
        <span><i style={{ background: C_E1RM }} />estimated 1RM</span>
        {stepsIn.length > 0 && <span><i style={{ background: C_TM }} />training max</span>}
        <span><i class="dot" style={{ background: C_E1RM }} />PR</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="estimated 1RM and training max over time"
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke={GRID} stroke-width="1" />
            <text x={L - 4} y={Y(v) + 3} text-anchor="end" class="tick">{v}</text>
          </g>
        ))}
        {xTicks.map((x) => <text key={x.x} x={x.x} y={H - 6} text-anchor="middle" class="tick">{x.label}</text>)}
        {tmPath && <path d={tmPath} fill="none" stroke={C_TM} stroke-width="2" stroke-linejoin="round" />}
        <path d={line} fill="none" stroke={C_E1RM} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        {points.map((p) => p.pr && <circle key={p.date} cx={X(p.date)} cy={Y(p.value)} r="4" fill={C_E1RM} stroke={SURFACE} stroke-width="2" />)}
        <circle cx={X(last.date)} cy={Y(last.value)} r="4" fill={C_E1RM} stroke={SURFACE} stroke-width="2" />
        <text x={X(last.date) + 6} y={Y(last.value) + 4} class="end-label">{last.value.toFixed(1)}</text>
        {h && (
          <g>
            <line x1={X(h.date)} x2={X(h.date)} y1={T} y2={H - B} stroke={INK_MUTED} stroke-width="1" />
            <circle cx={X(h.date)} cy={Y(h.value)} r="5" fill={C_E1RM} stroke={SURFACE} stroke-width="2" />
          </g>
        )}
      </svg>
      {h && (
        <div class="tooltip" style={{ left: `${Math.min(70, Math.max(0, (X(h.date) / W) * 100 - 15))}%` }}>
          <small>{h.date.split('-').reverse().join('.')}</small>
          <div><i style={{ background: C_E1RM }} /><b>{h.value.toFixed(1)}</b> {unit} e1RM{h.pr ? ' ★ PR' : ''}</div>
          {h.label && <div class="muted">{h.label}</div>}
          {tmAt(h.date) != null && <div><i style={{ background: C_TM }} /><b>{tmAt(h.date)}</b> {unit} TM</div>}
        </div>
      )}
    </div>
  );
}

/** One column per month, count on the cap. */
export function MonthBars({ months }: { months: { month: string; n: number }[] }) {
  const w = 360, h = 110, b = 18, top = 14;
  const max = Math.max(1, ...months.map((m) => m.n));
  const slot = w / months.length, bw = Math.min(24, slot - 6);
  return (
    <svg class="bars" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="workouts per month">
      <line x1="0" x2={w} y1={h - b} y2={h - b} stroke={GRID} stroke-width="1" />
      {months.map((m, i) => {
        const bh = (m.n / max) * (h - b - top);
        const x = i * slot + (slot - bw) / 2, y = h - b - bh;
        const r = Math.min(4, bh);
        return (
          <g key={m.month}>
            <title>{`${m.month}: ${m.n} workouts`}</title>
            {m.n > 0 && <path d={`M${x},${h - b}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${h - b}Z`} fill={C_E1RM} />}
            <text x={x + bw / 2} y={y - 3} text-anchor="middle" class="tick">{m.n || ''}</text>
            <text x={x + bw / 2} y={h - 5} text-anchor="middle" class="tick">{MONTHS[Number(m.month.slice(5)) - 1][0]}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** A bar from 0 to the top level, filled to `value`, with a tick at each level. */
export function LevelMeter({ value, targets, labels }: { value: number | null; targets: number[]; labels: string[] }) {
  const top = targets[targets.length - 1] * 1.05;
  const pct = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  return (
    <div class="meter" role="meter" aria-valuenow={value ?? 0} aria-valuemax={top}>
      <div class="meter-fill" style={{ width: pct(value ?? 0) }} />
      {targets.map((tg, i) => (
        <div key={i} class={`meter-tick ${value != null && value >= tg ? 'hit' : ''}`} style={{ left: pct(tg) }}>
          <span>{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}
