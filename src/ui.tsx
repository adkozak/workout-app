import type { ComponentChildren } from 'preact';
import type { Bootstrap, Lift, LiftKey, SetRow } from './api.ts';
import type { Inventory, Loading } from './plates.ts';
import {
  bestE1rm, daysBetween, e1rm, repPrAt, repTable, repsToBeat, sameWeekIn, trend, type Amrap,
} from './stats.ts';

export const BAR = 20;
export const kg = (x: number) => `${+x.toFixed(2)}`;
export const kg1 = (x: number) => `${+x.toFixed(1)}`; // estimates, not loadable weights
export const shortDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${+d}.${+m}.${y.slice(2)}`;
};

export const INVENTORY_KEY = 'inventory';
const PLATES = [20, 15, 10, 5, 2.5, 1.25];
const MAX_PAIRS = 4;

export const LIFT_LABEL: Record<string, string> = {
  squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', press: 'Press', wide_bench: 'Wide bench',
};

export function PlateStrip({ inventory, onChange }: { inventory: Inventory; onChange: (i: Inventory) => void }) {
  return (
    <section class="plates-strip">
      <span>Free today (pairs):</span>
      {PLATES.map((p) => (
        <button
          key={p}
          class={`chip ${inventory[p] ? '' : 'off'}`}
          onClick={() => onChange({ ...inventory, [p]: ((inventory[p] ?? 0) + 1) % (MAX_PAIRS + 1) })}
        >
          {p}<sub>×{inventory[p] ?? 0}</sub>
        </button>
      ))}
    </section>
  );
}

export function LiftHeader({ lift, list, data, hideTitle }: { lift: Lift; list: Amrap[]; data: Bootstrap; hideTitle?: boolean }) {
  const tm = lift.key ? data.cycle.tm[lift.key] : undefined;
  const best = bestE1rm(list);
  const first = list[0];
  const last90 = trend(list, 90);
  const bw = data.cycle.bodyweight;
  return (
    <div class="lift-head">
      {!hideTitle && (
        <div class="lift-title">
          <h2>{lift.key ? LIFT_LABEL[lift.key] : lift.name}</h2>
          {tm != null && <span class="muted">TM {kg(tm)}</span>}
        </div>
      )}
      {best && (
        <div class="facts">
          <span>best e1RM <b>{kg1(best.e1rm)}</b> <small>({shortDate(best.date)})</small></span>
          {bw && <span><b>{(best.e1rm / bw).toFixed(2)}×</b> bodyweight</span>}
          {last90 != null && <span class={last90 >= 0 ? 'up' : 'down'}>{last90 >= 0 ? '▲' : '▼'} {kg1(Math.abs(last90))} kg vs previous 90 days</span>}
          {first && first !== best && (
            <span>+{kg1(best.e1rm - first.e1rm)} kg since {shortDate(first.date)} ({Math.round((best.e1rm / first.e1rm - 1) * 100)}%)</span>
          )}
          <span>AMRAP #{list.length + 1} on this lift</span>
        </div>
      )}
      {list.length > 2 && <Sparkline values={list.map((a) => a.e1rm)} />}
    </div>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  const w = 300, h = 40, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 3 - ((v - min) / span) * (h - 6)}`);
  const bestIdx = values.indexOf(max);
  const [bx, by] = pts[bestIdx].split(',');
  return (
    <svg class="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="estimated 1RM over time">
      <polyline points={pts.join(' ')} fill="none" stroke="#3e63dd" stroke-width="2" vector-effect="non-scaling-stroke" />
      <circle cx={bx} cy={by} r="3" fill="#f5a524" />
    </svg>
  );
}

export function SetView({ set, loading, children }: { set: SetRow; loading: Loading; children?: ComponentChildren }) {
  const label = set.kind === 'supplemental' ? `${set.sets}×${set.reps}` : set.reps;
  const perSide = (loading.total - BAR) / 2;
  return (
    <div class={`set ${set.kind}`}>
      <div class="set-head">
        <div>
          <span class="weight">{kg(set.weight)}</span>
          <span class="reps"> × {label}</span>
          {set.pct != null && <span class="muted pct">{Math.round(set.pct * 100)}%</span>}
        </div>
        <div class="per-side">
          {perSide > 0 ? <><b>{kg(perSide)}</b><small> /side</small></> : <small>bar</small>}
        </div>
      </div>
      <Plates loading={loading} />
      {children}
    </div>
  );
}

export function Plates({ loading }: { loading: Loading }) {
  if (loading.perSide.length === 0) return null;
  return (
    <div class="plates">
      {loading.perSide.map((p, i) => <span key={i} class={`plate p${String(p).replace('.', '_')}`}>{p}</span>)}
      <span class="muted change">
        {loading.changes === 0 ? 'no change' : `${loading.changes} change${loading.changes > 1 ? 's' : ''}`}
        {!loading.exact && ` · only ≈${kg(loading.total)} kg possible`}
      </span>
    </div>
  );
}

export function AmrapPanel({ set, lift, liftKey, list, week, data }: {
  set: SetRow; lift: Lift; liftKey: LiftKey; list: Amrap[]; week: number; data: Bootstrap;
}) {
  const minReps = parseInt(set.reps, 10) || 1;
  const best = bestE1rm(list);
  const pr = repPrAt(list, set.weight);
  const last = list[list.length - 1];
  const lastCycle = sameWeekIn(data.previous, week, liftKey);
  const mainPcts = lift.sets.filter((s) => s.kind !== 'warmup' && s.kind !== 'supplemental').map((s) => s.pct ?? 0);
  const rows = repTable({ weight: set.weight, minReps, list, tm: data.cycle.tm[liftKey], mainPcts, key: liftKey, week, lastReps: lastCycle?.reps ?? last?.reps });
  const beat = best ? repsToBeat(best.e1rm, set.weight) : null;

  return (
    <div class="amrap">
      <div class="goals">
        {beat != null && <div class="goal"><b>{beat}</b><small>reps for e1RM PR</small></div>}
        {pr && <div class="goal"><b>{pr.reps + 1}</b><small>for rep PR at {kg(set.weight)}</small></div>}
        {lastCycle && <div class="goal"><b>{lastCycle.reps}</b><small>last cycle wk{week} @ {kg(lastCycle.weight)}</small></div>}
      </div>
      <ul class="facts-list">
        {last && (
          <li>Last AMRAP: {kg(last.weight)} × {last.reps} ({shortDate(last.date)}, {daysBetween(last.date, new Date().toISOString().slice(0, 10))} days ago) → e1RM {kg1(last.e1rm)}</li>
        )}
        {lastCycle && (
          <li>
            Last cycle, same week: {kg(lastCycle.weight)} × {lastCycle.reps} → e1RM {kg1(e1rm(lastCycle.weight, lastCycle.reps))}.
            {' '}Matching that e1RM today takes {repsToBeat(e1rm(lastCycle.weight, lastCycle.reps) - 1e-6, set.weight)} reps.
          </li>
        )}
        {pr && <li>Rep PR at {kg(set.weight)} kg: {pr.reps} ({shortDate(pr.date)})</li>}
      </ul>
      <table class="rep-table">
        <thead>
          <tr><th>reps</th><th>e1RM</th><th>5×5</th>{week === 3 && <th>next TM</th>}<th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.reps} class={r.beatsBest ? 'pr' : ''}>
              <td>{r.reps}</td>
              <td>{kg1(r.e1rm)}</td>
              <td>{r.suppWeight != null ? kg(r.suppWeight) : ''}</td>
              {week === 3 && <td>{r.tmBump != null ? `+${kg(r.tmBump)}` : ''}</td>}
              <td class="marks">{r.beatsBest ? '★ e1RM PR' : r.isRepPr && pr ? 'rep PR' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Stepper({ value, step, min, onChange, big }: { value: number; step: number; min: number; onChange: (v: number) => void; big?: boolean }) {
  return (
    <span class={`stepper ${big ? 'big' : ''}`}>
      <button type="button" onClick={() => onChange(Math.max(min, +(value - step).toFixed(2)))}>−</button>
      <b>{+value.toFixed(2)}</b>
      <button type="button" onClick={() => onChange(+(value + step).toFixed(2))}>+</button>
    </span>
  );
}
