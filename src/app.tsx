import { useEffect, useMemo, useState } from 'preact/hooks';
import { SessionView } from './SessionView.tsx';
import { startSync } from './queue.ts';
import { findDay, loadSession, newSession, saveSession, type Session } from './session.ts';
import {
  cachedBootstrap, fetchBootstrap, getConfig, nextDay, saveSetup,
  type Bootstrap, type Day, type Lift, type LiftKey, type SetRow,
} from './api.ts';
import { DEFAULT_INVENTORY, planLoadings, type Inventory } from './plates.ts';
import { bestE1rm, daysBetween, liftHistory } from './stats.ts';
import {
  AmrapPanel, BAR, INVENTORY_KEY, LIFT_LABEL, LiftHeader, PlateStrip, SetView, kg, kg1, shortDate,
} from './ui.tsx';

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

  const [session, setSessionState] = useState<Session | null>(loadSession);
  const [pick, setPick] = useState<{ week: number; day: number } | null>(null);
  const setSession = (s: Session | null) => { saveSession(s); setSessionState(s); };

  const refresh = () => {
    if (!cfg) return;
    setSyncing(true);
    fetchBootstrap(cfg)
      .then((d) => { setData(d); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSyncing(false));
  };
  useEffect(refresh, []);
  useEffect(() => (cfg ? startSync(cfg) : undefined), []);

  useEffect(() => localStorage.setItem(INVENTORY_KEY, JSON.stringify(inventory)), [inventory]);

  if (!cfg) {
    return (
      <main class="empty">
        <h1>5/3/1</h1>
        <p>Not set up yet. Scan the setup QR code with this phone, or paste the setup link here:</p>
        <SetupForm />
      </main>
    );
  }
  if (!data) {
    return <main class="empty"><p>{error ? `Could not load: ${error}` : 'Loading your sheet…'}</p></main>;
  }

  if (session) {
    return (
      <SessionView cfg={cfg} data={data} session={session} setSession={setSession}
        inventory={inventory} setInventory={setInventory} onClose={refresh} />
    );
  }

  const auto = nextDay(data.cycle);
  const chosen = pick ?? (auto ? { week: auto.week, day: auto.day.day } : null);
  const chosenDay = chosen ? findDay(data.cycle, chosen.week, chosen.day) : null;
  return (
    <main>
      <header>
        <div>
          <h1>{chosen ? `Week ${chosen.week} · Day ${chosen.day}` : 'Cycle done'}</h1>
          <small>{data.cycle.name}{syncing ? ' · syncing…' : error ? ` · offline (${error})` : ''}</small>
        </div>
        <select
          class="day-pick"
          value={chosen ? `${chosen.week}-${chosen.day}` : ''}
          onChange={(e) => { const [w, d] = e.currentTarget.value.split('-').map(Number); setPick({ week: w, day: d }); }}
        >
          {data.cycle.weeks.flatMap((w) => w.days.map((d) => (
            <option key={`${w.week}-${d.day}`} value={`${w.week}-${d.day}`}>
              W{w.week} D{d.day} · {d.lifts.map((l) => (l.key ? LIFT_LABEL[l.key] : l.name)).join('+')}
            </option>
          )))}
        </select>
      </header>
      {chosen && chosenDay && data.cycle.writable && (
        <button class="btn primary start" onClick={() => setSession(newSession(data.cycle, chosen.week, chosen.day))}>
          ▶ Start workout
        </button>
      )}
      {!data.cycle.writable && <p class="down">This cycle's layout isn't recognised, so logging is off: {data.cycle.layoutProblems[0]}</p>}
      <PlateStrip inventory={inventory} onChange={setInventory} />
      {chosen && chosenDay ? <DayView day={chosenDay} week={chosen.week} data={data} inventory={inventory} /> : <p>All AMRAPs in {data.cycle.name} are logged.</p>}
      <OverallStats data={data} />
    </main>
  );
}

function SetupForm() {
  const [value, setValue] = useState('');
  const [bad, setBad] = useState(false);
  return (
    <form
      class="setup"
      onSubmit={(e) => {
        e.preventDefault();
        if (saveSetup(value)) location.reload();
        else setBad(true);
      }}
    >
      <textarea rows={4} value={value} placeholder="https://…#setup=…" onInput={(e) => { setValue(e.currentTarget.value); setBad(false); }} />
      <button class="chip" type="submit">Save</button>
      {bad && <p class="down">That doesn't look like a setup link.</p>}
    </form>
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
