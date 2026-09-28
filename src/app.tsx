import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  cachedBootstrap, fetchBootstrap, getConfig, nextDay,
  type Bootstrap, type Day, type Lift, type LiftKey, type SetRow,
} from './api.ts';
import { DEFAULT_INVENTORY, planLoadings, type Inventory, type Loading } from './plates.ts';
import {
  bestE1rm, daysBetween, e1rm, liftHistory, repPrAt, repTable, repsToBeat, sameWeekIn, trend, type Amrap,
} from './stats.ts';

const BAR = 20;
const kg = (x: number) => `${+x.toFixed(2)}`;
const kg1 = (x: number) => `${+x.toFixed(1)}`; // estimates, not loadable weights
const shortDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${+d}.${+m}.${y.slice(2)}`;
};

const INVENTORY_KEY = 'inventory';
const PLATES = [20, 15, 10, 5, 2.5, 1.25];
const MAX_PAIRS = 4;

const LIFT_LABEL: Record<string, string> = {
  squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', press: 'Press', wide_bench: 'Wide bench',
};

function loadInventory(): Inventory {
  const raw = localStorage.getItem(INVENTORY_KEY);
  return raw ? (JSON.parse(raw) as Inventory) : DEFAULT_INVENTORY;
}

export function App() {
  const cfg = getConfig();
  const [data, setData] = useState<Bootstrap | null>(cachedBootstrap());
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [inventory, setInventory] = useState<Inventory>(loadInventory);

  useEffect(() => {
    if (!cfg) return;
    setSyncing(true);
    fetchBootstrap(cfg)
      .then((d) => { setData(d); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSyncing(false));
  }, []);

  useEffect(() => localStorage.setItem(INVENTORY_KEY, JSON.stringify(inventory)), [inventory]);

  if (!cfg) {
    return (
      <main class="empty">
        <h1>5/3/1</h1>
        <p>Not set up. Open the setup link once on this phone.</p>
      </main>
    );
  }
  if (!data) {
    return <main class="empty"><p>{error ? `Could not load: ${error}` : 'Loading your sheet…'}</p></main>;
  }

  const next = nextDay(data.cycle);
  return (
    <main>
      <header>
        <div>
          <h1>{next ? `Week ${next.week} · Day ${next.day.day}` : 'Cycle done'}</h1>
          <small>{data.cycle.name}{syncing ? ' · syncing…' : error ? ` · offline (${error})` : ''}</small>
        </div>
      </header>
      <PlateStrip inventory={inventory} onChange={setInventory} />
      {next ? <DayView day={next.day} week={next.week} data={data} inventory={inventory} /> : <p>All AMRAPs in {data.cycle.name} are logged.</p>}
      <OverallStats data={data} />
    </main>
  );
}

function PlateStrip({ inventory, onChange }: { inventory: Inventory; onChange: (i: Inventory) => void }) {
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

function DayView({ day, week, data, inventory }: { day: Day; week: number; data: Bootstrap; inventory: Inventory }) {
  return (
    <>
      {day.lifts.map((lift) => (
        <LiftView key={lift.name} lift={lift} week={week} data={data} inventory={inventory} />
      ))}
      {day.assistance.length > 0 && (
        <section class="card">
          <h2>Assistance</h2>
          {day.assistance.map((a) => (
            <div class="row" key={a.index}>
              <span>{a.name}</span>
              <span class="muted">{a.weight ? `${a.weight} kg · ` : ''}{a.sets}×{a.reps ?? '?'}</span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function LiftView({ lift, week, data, inventory }: { lift: Lift; week: number; data: Bootstrap; inventory: Inventory }) {
  const loadings = useMemo(
    () => planLoadings(lift.sets.map((s) => s.weight), inventory, BAR),
    [lift, inventory],
  );
  const list = useMemo(() => (lift.key ? liftHistory(data.history, lift.key) : []), [lift, data]);
  return (
    <section class="card">
      <LiftHeader lift={lift} list={list} data={data} />
      {lift.sets.map((s, i) => (
        <SetView key={s.index} set={s} loading={loadings[i]}>
          {s.kind === 'amrap' && lift.key && (
            <AmrapPanel set={s} lift={lift} liftKey={lift.key} list={list} week={week} data={data} />
          )}
        </SetView>
      ))}
    </section>
  );
}

function LiftHeader({ lift, list, data }: { lift: Lift; list: Amrap[]; data: Bootstrap }) {
  const tm = lift.key ? data.cycle.tm[lift.key] : undefined;
  const best = bestE1rm(list);
  const first = list[0];
  const last90 = trend(list, 90);
  const bw = data.cycle.bodyweight;
  return (
    <div class="lift-head">
      <div class="lift-title">
        <h2>{lift.key ? LIFT_LABEL[lift.key] : lift.name}</h2>
        {tm != null && <span class="muted">TM {kg(tm)}</span>}
      </div>
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

function Sparkline({ values }: { values: number[] }) {
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

function SetView({ set, loading, children }: { set: SetRow; loading: Loading; children?: preact.ComponentChildren }) {
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

function Plates({ loading }: { loading: Loading }) {
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

function AmrapPanel({ set, lift, liftKey, list, week, data }: {
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

function OverallStats({ data }: { data: Bootstrap }) {
  const sessions = data.history.sessions;
  if (sessions.length === 0) return null;
  const first = sessions[0].date;
  const today = new Date().toISOString().slice(0, 10);
  const bestOf = (k: LiftKey) => bestE1rm(liftHistory(data.history, k))?.e1rm ?? 0;
  const total = bestOf('squat') + bestOf('bench') + bestOf('deadlift');
  const firstTm = data.history.trainingMaxes.find((t) => t.number === 1)?.tm;
  const nowTm = data.cycle.tm;
  const bw = data.cycle.bodyweight;
  return (
    <section class="card">
      <h2>Since {shortDate(first)}</h2>
      <div class="facts">
        <span><b>{sessions.length}</b> logged sessions over <b>{daysBetween(first, today)}</b> days</span>
        <span>cycle <b>{data.cycle.number}</b></span>
        <span>SBD e1RM total <b>{kg1(total)}</b> kg{bw ? ` (${(total / bw).toFixed(1)}× bodyweight)` : ''}</span>
      </div>
      {firstTm && (
        <table class="rep-table">
          <thead><tr><th>TM</th><th>cycle 1</th><th>now</th><th>gain</th></tr></thead>
          <tbody>
            {(['squat', 'bench', 'deadlift', 'press'] as LiftKey[]).map((k) =>
              firstTm[k] != null && nowTm[k] != null ? (
                <tr key={k}>
                  <td>{LIFT_LABEL[k]}</td><td>{kg(firstTm[k]!)}</td><td>{kg(nowTm[k]!)}</td>
                  <td class="up">+{kg(nowTm[k]! - firstTm[k]!)}</td>
                </tr>
              ) : null,
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
