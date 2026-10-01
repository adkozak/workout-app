import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AssistPlan } from './AssistPlan.tsx';
import { CycleView } from './CycleView.tsx';
import { HistoryList, SessionDetail } from './HistoryView.tsx';
import { ProgressView } from './ProgressView.tsx';
import { SessionView } from './SessionView.tsx';
import { enqueue, startSync } from './queue.ts';
import { sessionKey, touch, type LiveDoc } from './live.ts';
import { startLive, type LiveSync } from './liveSync.ts';
import {
  assistPlanOp, defaultLiftOrder, findDay, loadSession, localDate, newSession, saveSession, uuid, type Session,
} from './session.ts';
import {
  cachedArchive, cachedBootstrap, fetchArchive, fetchBootstrap, getConfig, nextDay, saveCachedBootstrap, saveSetup,
  type Archive, type Assistance, type Bootstrap, type Cycle, type Day, type Lift,
} from './api.ts';
import { assistanceLog, buildSessions, lastTrained, type AssistDone, type PastSession } from './history.ts';
import { DEFAULT_INVENTORY, planLoadings, type Inventory } from './plates.ts';
import { daysBetween, liftHistory } from './stats.ts';
import {
  AmrapPanel, BAR, INVENTORY_KEY, LIFT_LABEL, LiftHeader, PlateStrip, SetView, shortDate,
} from './ui.tsx';

const TABS = [
  { route: '', label: 'Today', icon: '●' },
  { route: 'history', label: 'History', icon: '☰' },
  { route: 'progress', label: 'Progress', icon: '↗' },
  { route: 'cycle', label: 'Cycle', icon: '↻' },
];
/** The archive is several sheet reads: reload it when older than this on opening a screen that uses it. */
const ARCHIVE_FRESH_MS = 10 * 60e3;

function useRoute(): [string, string, (hash: string) => void] {
  const read = () => decodeURIComponent(location.hash.replace(/^#/, ''));
  const [hash, setHash] = useState(read);
  useEffect(() => {
    const on = () => { setHash(read()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const i = hash.indexOf('/');
  const go = (h: string) => { location.hash = h; };
  return [i < 0 ? hash : hash.slice(0, i), i < 0 ? '' : hash.slice(i + 1), go];
}

/** Cycle tabs for history: the archive's, with the freshly loaded current/previous cycle in place of their cached copies. */
function mergedCycles(data: Bootstrap, archive: Archive | null): Cycle[] {
  const fresh = [data.cycle, data.previous].filter((c): c is Cycle => !!c);
  const rest = (archive?.cycles ?? []).filter((c) => !fresh.some((f) => f.name === c.name));
  return [...fresh.filter((c) => c.writable), ...rest];
}

function loadInventory(): Inventory {
  const raw = localStorage.getItem(INVENTORY_KEY);
  return raw ? (JSON.parse(raw) as Inventory) : DEFAULT_INVENTORY;
}

export function App() {
  const cfg = getConfig();
  const [data, setData] = useState<Bootstrap | null>(cachedBootstrap());
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [inventory, setInventoryState] = useState<Inventory>(loadInventory);

  const [session, setSessionState] = useState<Session | null>(loadSession);
  const [pick, setPick] = useState<{ week: number; day: number } | null>(null);
  const [liveDoc, setLiveDoc] = useState<LiveDoc | null>(null);
  const live = useRef<LiveSync | null>(null);
  const [route, param, go] = useRoute();
  const [archive, setArchive] = useState<Archive | null>(cachedArchive());
  const [archiveState, setArchiveState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });

  /** A change made here: stamped for merging, and sent to the watch right away. */
  const setSession = (s: Session | null) => {
    const prev = loadSession();
    const next = s ? touch(prev, s) : null;
    saveSession(next);
    setSessionState(next);
    if (!next && prev && !prev.practice) live.current?.close(sessionKey(prev));
    live.current?.poke();
  };
  const setInventory = (inv: Inventory) => { setInventoryState(inv); live.current?.inventoryChanged(inv); };

  useEffect(() => {
    if (!cfg) return;
    live.current = startLive(cfg, {
      getSession: loadSession,
      setSession: (s) => { saveSession(s); setSessionState(s); },
      setInventory: setInventoryState,
      onDoc: setLiveDoc,
    });
    return () => live.current?.stop();
  }, []);

  const loadArchive = (maxAgeMs = 0) => {
    if (!cfg || archiveState.loading) return;
    const cached = cachedArchive();
    if (maxAgeMs && cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < maxAgeMs) return;
    setArchiveState({ loading: true, error: null });
    fetchArchive(cfg)
      .then((a) => { setArchive(a); setArchiveState({ loading: false, error: null }); })
      .catch((e: Error) => setArchiveState({ loading: false, error: e.message }));
  };
  useEffect(() => loadArchive(route ? ARCHIVE_FRESH_MS : 6 * 3600e3), [route]);

  const today = localDate();
  const sessions = useMemo<PastSession[]>(() => (data ? buildSessions(data.history, mergedCycles(data, archive)) : []), [data, archive]);
  const assist = useMemo<Map<string, AssistDone[]>>(() => assistanceLog(sessions), [sessions]);

  /** Changes the loaded sheet copy right away; the op makes it true in the sheet. */
  const patchCycle = (fn: (c: Cycle) => void) => {
    // Functional update: several patches in one go ("use all") must build on each other.
    setData((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev)) as Bootstrap;
      fn(next.cycle);
      saveCachedBootstrap(next);
      return next;
    });
  };
  const planAssistance = (week: number, day: number, a: Assistance, v: { weight: number | null; reps: number | string | null }) => {
    if (!cfg || !data) return;
    enqueue(cfg, assistPlanOp(data.cycle.name, week, day, a.index, a.name, v));
    patchCycle((c) => {
      const x = findDay(c, week, day)?.assistance.find((y) => y.index === a.index);
      if (x) { x.weight = v.weight; x.reps = v.reps; }
    });
  };
  const setBodyweight = (kgs: number) => {
    if (!cfg || !data) return;
    enqueue(cfg, {
      id: uuid(), type: 'bodyweight', kind: 'bodyweight', exercise: 'bodyweight',
      cycle: data.cycle.name, actualWeight: kgs, status: 'done', sessionDate: today,
    });
    patchCycle((c) => { c.bodyweight = kgs; });
  };

  const refresh = () => {
    if (!cfg) return;
    setSyncing(true);
    fetchBootstrap(cfg, loadSession()?.cycle)
      .then((d) => { setData(d); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSyncing(false));
  };
  useEffect(refresh, []);
  // A PWA resumed from the background doesn't restart, so reload the sheet when it comes back.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  // A workout from another cycle (e.g. started on the watch): load that cycle.
  const openCycle = session?.cycle;
  useEffect(() => { if (openCycle && data && openCycle !== data.cycle.name) refresh(); }, [openCycle]);
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

  if (session && !route) {
    return (
      <SessionView cfg={cfg} data={data} session={session} setSession={setSession}
        inventory={inventory} setInventory={setInventory} onClose={() => { refresh(); loadArchive(); }} onReload={refresh} syncing={syncing} watchHr={liveDoc?.hr ?? null} />
    );
  }

  const nav = (
    <nav class="tabbar">
      {TABS.map((t) => (
        <button key={t.route} class={route === t.route ? 'on' : ''} onClick={() => go(t.route)}>
          <span>{t.icon}</span>{t.label}
        </button>
      ))}
    </nav>
  );
  if (route) {
    const loadingNote = archiveState.loading
      ? <small class="muted">loading all cycles…</small>
      : archiveState.error ? <small class="down">cycles not loaded: {archiveState.error}</small> : null;
    const title = route === 'history' ? 'History' : route === 'progress' ? 'Progress' : route === 'cycle' ? 'Cycle' : route;
    return (
      <main class="tabbed">
        {session && <button class="banner" onClick={() => go('')}>Workout in progress: W{session.week} D{session.day} ▶</button>}
        {!(route === 'history' && param) && (
          <header>
            <div><h1>{title}</h1>{loadingNote}</div>
            <button class="btn small ghost" onClick={() => { refresh(); loadArchive(); }}>{syncing || archiveState.loading ? '…' : '⟳'}</button>
          </header>
        )}
        {route === 'history' && (param ? <SessionDetail sessions={sessions} id={param} go={go} /> : <HistoryList sessions={sessions} go={go} />)}
        {route === 'progress' && <ProgressView data={data} archive={archive} sessions={sessions} assist={assist} today={today} onBodyweight={setBodyweight} />}
        {route === 'cycle' && (
          <CycleView cfg={cfg} data={data} archive={archive} sessions={sessions} today={today}
            onCreated={() => { location.hash = ''; refresh(); loadArchive(); }} />
        )}
        {nav}
      </main>
    );
  }

  const auto = nextDay(data.cycle);
  const chosen = pick ?? (auto ? { week: auto.week, day: auto.day.day } : null);
  const chosenDay = chosen ? findDay(data.cycle, chosen.week, chosen.day) : null;
  const trained = lastTrained(sessions);
  return (
    <main class="tabbed">
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
              W{w.week} D{d.day} · {defaultLiftOrder(d).map((i) => { const l = d.lifts[i]; return l.key ? LIFT_LABEL[l.key] : l.name; }).join('+')}
            </option>
          )))}
        </select>
      </header>
      {chosen && chosenDay && data.cycle.writable && (
        <>
          <button class="btn primary start" onClick={() => setSession(newSession(data.cycle, chosen.week, chosen.day))}>
            ▶ Start workout
          </button>
          <button class="btn ghost practice-start" onClick={() => setSession(newSession(data.cycle, chosen.week, chosen.day, true))}>
            Practice run: try the workout screen, nothing is saved
          </button>
        </>
      )}
      {!data.cycle.writable && <p class="down">This cycle's layout isn't recognised, so logging is off: {data.cycle.layoutProblems[0]}</p>}
      <PlateStrip inventory={inventory} onChange={setInventory} />
      {trained && <p class="muted small-note">Last workout {shortDate(trained)} · {daysBetween(trained, today)} days ago</p>}
      {chosen && chosenDay && chosenDay.assistance.length > 0 && data.cycle.writable && (
        <AssistPlan day={chosenDay} archive={archive} assist={assist} trained={trained} today={today}
          onSave={(a, v) => planAssistance(chosen.week, chosen.day, a, v)} />
      )}
      {chosen && chosenDay ? <DayView day={chosenDay} week={chosen.week} data={data} inventory={inventory} /> : (
        <section class="card">
          <p>All AMRAPs in {data.cycle.name} are logged.</p>
          <button class="btn primary wide" onClick={() => go('cycle')}>Set up the next cycle</button>
        </section>
      )}
      {nav}
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
      {defaultLiftOrder(day).map((li) => (
        <LiftView key={day.lifts[li].name} lift={day.lifts[li]} week={week} data={data} inventory={inventory} />
      ))}
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
