import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  cachedBootstrap, fetchBootstrap, getConfig, nextDay,
  type Bootstrap, type Day, type Lift, type SetRow,
} from './api.ts';
import { DEFAULT_INVENTORY, planLoadings, type Inventory, type Loading } from './plates.ts';

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
      {next ? <DayView day={next.day} inventory={inventory} /> : <p>All AMRAPs in {data.cycle.name} are logged.</p>}
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

function DayView({ day, inventory }: { day: Day; inventory: Inventory }) {
  return (
    <>
      {day.lifts.map((lift) => <LiftView key={lift.name} lift={lift} inventory={inventory} />)}
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

function LiftView({ lift, inventory }: { lift: Lift; inventory: Inventory }) {
  const loadings = useMemo(
    () => planLoadings(lift.sets.map((s) => s.weight), inventory),
    [lift, inventory],
  );
  return (
    <section class="card">
      <h2>{lift.key ? LIFT_LABEL[lift.key] : lift.name}</h2>
      {lift.sets.map((s, i) => <SetView key={s.index} set={s} loading={loadings[i]} />)}
    </section>
  );
}

function SetView({ set, loading }: { set: SetRow; loading: Loading }) {
  const label = set.kind === 'supplemental' ? `${set.sets}×${set.reps}` : set.reps;
  return (
    <div class={`set ${set.kind}`}>
      <div class="set-head">
        <span class="weight">{set.weight} kg</span>
        <span class="reps">× {label}</span>
        {set.pct != null && <span class="muted">{Math.round(set.pct * 100)}%</span>}
      </div>
      <Plates loading={loading} />
    </div>
  );
}

function Plates({ loading }: { loading: Loading }) {
  if (loading.perSide.length === 0) return <div class="plates muted">empty bar</div>;
  return (
    <div class="plates">
      <span class="sleeve" />
      {loading.perSide.map((p, i) => <span key={i} class={`plate p${String(p).replace('.', '_')}`}>{p}</span>)}
      <span class="muted change">
        {loading.changes === 0 ? 'no change' : `${loading.changes} change${loading.changes > 1 ? 's' : ''}`}
        {!loading.exact && ` · ≈${loading.total} kg`}
      </span>
    </div>
  );
}
