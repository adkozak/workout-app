import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Bootstrap, Config, Day } from './api.ts';
import { planLoadings, type Inventory } from './plates.ts';
import { enqueue, onSync, syncState, type SyncState } from './queue.ts';
import {
  assistOp, buildItems, currentItem, entryFor, findDay, plannedReps, plannedWeight, restFor, rmOp, roundOp,
  saveSession, setOp, type Entry, type Item, type Session,
} from './session.ts';
import { bestE1rm, e1rm, liftHistory, repPrAt } from './stats.ts';
import { AmrapPanel, BAR, LIFT_LABEL, PlateStrip, Plates, kg, kg1 } from './ui.tsx';

type SetItem = Item & { type: 'set' };

interface Props {
  cfg: Config;
  data: Bootstrap;
  session: Session;
  setSession: (s: Session | null) => void;
  inventory: Inventory;
  setInventory: (i: Inventory) => void;
  onClose: () => void;
}

export function SessionView({ cfg, data, session, setSession, inventory, setInventory, onClose }: Props) {
  const day = session.cycle === data.cycle.name ? findDay(data.cycle, session.week, session.day) : null;
  const items = useMemo(() => (day ? buildItems(day) : []), [day]);
  const [editing, setEditing] = useState<string | null>(null);
  const [rest, setRest] = useState<{ endsAt: number; total: number } | null>(null);
  const [sync, setSync] = useState<SyncState>(syncState());
  useEffect(() => onSync(setSync), []);
  useWakeLock(!session.finishedAt);

  const current = day ? currentItem(items, session, day) : null;
  useEffect(() => {
    const id = editing ?? current?.id;
    if (id) document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [current?.id, editing]);

  if (!day) {
    return (
      <main class="empty">
        <p>This workout ({session.cycle} week {session.week} day {session.day}) is not in the sheet any more.</p>
        <button class="btn" onClick={() => { setSession(null); onClose(); }}>Discard it</button>
      </main>
    );
  }

  const doneCount = items.filter((it) => entryFor(it, session, day)).length;

  const plannedOf = (it: SetItem) => ({ weight: plannedWeight(it, session, day, data.cycle.tm), reps: it.row.reps });

  const record = (item: Item, entry: Entry | null) => {
    const entries = { ...session.entries };
    entries[item.id] = entry ?? { status: 'open', at: new Date().toISOString() };
    const next = { ...session, entries };
    setSession(next);
    setEditing(null);
    enqueue(cfg, item.type === 'set'
      ? setOp(item, next, entry, { weight: plannedOf(item).weight, reps: item.row.reps })
      : roundOp(item.round, next, !!entry));
    if (entry && entry.status !== 'skipped') {
      const secs = restFor(item);
      setRest({ endsAt: Date.now() + secs * 1000, total: secs });
    }
  };

  const finish = () => {
    const op = rmOp(items, session, day);
    if (op) enqueue(cfg, op);
    setSession({ ...session, finishedAt: new Date().toISOString() });
    setRest(null);
  };

  if (session.finishedAt) {
    return <Summary data={data} session={session} items={items} day={day} sync={sync} onClose={() => { setSession(null); onClose(); }} />;
  }

  const lifts = day.lifts.map((lift, li) => {
    const its = items.filter((it): it is SetItem => it.type === 'set' && it.lift === li + 1);
    const weights = its.map((it) => session.entries[it.id]?.weight ?? plannedOf(it).weight);
    return { lift, its, loadings: planLoadings(weights, inventory, BAR) };
  });

  return (
    <main class="session">
      <header class="session-head">
        <div>
          <h1>W{session.week} · D{session.day}</h1>
          <small>{day.lifts.map((l) => (l.key ? LIFT_LABEL[l.key] : l.name)).join(' + ')}</small>
        </div>
        <div class="progress-wrap">
          <span>{doneCount}/{items.length}</span>
          <SyncBadge sync={sync} />
        </div>
        <div class="progress"><div style={{ width: `${(doneCount / items.length) * 100}%` }} /></div>
      </header>

      <PlateStrip inventory={inventory} onChange={setInventory} />

      {lifts.map(({ lift, its, loadings }) => (
        <section class="card" key={lift.name}>
          <h2>{lift.key ? LIFT_LABEL[lift.key] : lift.name} <small class="muted">TM {kg(data.cycle.tm[lift.key!] ?? 0)}</small></h2>
          {its.map((it, i) => {
            const entry = entryFor(it, session, day);
            const open = it.id === editing || (!editing && it.id === current?.id);
            return (
              <SetItemView
                key={it.id}
                item={it}
                entry={entry}
                open={open}
                isCurrent={it.id === current?.id}
                planned={plannedOf(it)}
                loading={loadings[i]}
                data={data}
                week={session.week}
                onRecord={(e) => record(it, e)}
                onEdit={() => setEditing(open ? null : it.id)}
              />
            );
          })}
        </section>
      ))}

      {day.assistance.length > 0 && (
        <AssistanceView
          day={day}
          items={items.filter((it): it is Item & { type: 'round' } => it.type === 'round')}
          session={session}
          current={current}
          onRound={(it, done) => record(it, done ? { status: 'done', at: new Date().toISOString() } : null)}
          onExercise={(index, name, values) => {
            const entry: Entry = {
              status: 'done', at: new Date().toISOString(), name,
              weight: values.weight ?? undefined, reps: typeof values.reps === 'number' ? values.reps : undefined, note: values.note,
            };
            const entries = { ...session.entries, [`X:${index}`]: entry };
            const next = { ...session, entries };
            setSession(next);
            enqueue(cfg, assistOp(next, index, name, values));
          }}
        />
      )}

      <button class="btn finish" onClick={() => {
        if (current && !confirm('Not everything is ticked. Finish anyway?')) return;
        finish();
      }}>
        Finish workout
      </button>
      <button class="btn ghost" onClick={() => {
        if (confirm('Leave this workout? What you logged stays in the sheet.')) { setSession(null); onClose(); }
      }}>
        Leave without finishing
      </button>

      {rest && <RestTimer rest={rest} onChange={setRest} />}
    </main>
  );
}

function SetItemView({ item, entry, open, isCurrent, planned, loading, data, week, onRecord, onEdit }: {
  item: SetItem; entry: Entry | null; open: boolean; isCurrent: boolean;
  planned: { weight: number; reps: string }; loading: ReturnType<typeof planLoadings>[number];
  data: Bootstrap; week: number; onRecord: (e: Entry | null) => void; onEdit: () => void;
}) {
  const { row } = item;
  const perSide = (loading.total - BAR) / 2;
  const label = row.kind === 'supplemental' ? `5×5 · ${item.sub + 1}/${row.sets}` : row.kind === 'warmup' ? 'warm-up' : row.kind === 'amrap' ? 'AMRAP' : `${Math.round((row.pct ?? 0) * 100)}%`;
  const status = entry?.status;
  const icon = status === 'done' ? '✓' : status === 'changed' ? '✎' : status === 'skipped' ? '⤼' : isCurrent ? '▶' : '';
  const shownWeight = entry?.weight ?? planned.weight;
  const shownReps = entry?.reps ?? planned.reps;

  if (!open) {
    return (
      <div id={item.id} class={`item ${status ?? 'todo'}`} onClick={onEdit}>
        <span class="icon">{icon}</span>
        <span class="what"><b>{kg(shownWeight)}</b> × {shownReps} <small class="muted">{label}</small></span>
        <span class="side">{status === 'skipped' ? 'skipped' : perSide > 0 ? `${kg(perSide)}/side` : 'bar'}</span>
      </div>
    );
  }
  return (
    <div id={item.id} class={`item-card ${isCurrent ? 'current' : ''}`}>
      <div class="set-head">
        <div>
          <span class="weight">{kg(planned.weight)}</span>
          <span class="reps"> × {planned.reps}</span>
          <span class="muted pct">{label}</span>
        </div>
        <div class="per-side">{perSide > 0 ? <><b>{kg(perSide)}</b><small> /side</small></> : <small>bar</small>}</div>
      </div>
      <Plates loading={loading} />
      <SetActions item={item} entry={entry} planned={planned} onRecord={onRecord} />
      {row.kind === 'amrap' && item.liftRef.key && (
        <details class="amrap-details" open={isCurrent}>
          <summary>AMRAP targets & stats</summary>
          <AmrapPanel set={{ ...row, weight: planned.weight }} lift={item.liftRef} liftKey={item.liftRef.key} list={liftHistory(data.history, item.liftRef.key)} week={week} data={data} />
        </details>
      )}
    </div>
  );
}

function SetActions({ item, entry, planned, onRecord }: {
  item: SetItem; entry: Entry | null; planned: { weight: number; reps: string }; onRecord: (e: Entry | null) => void;
}) {
  const amrap = item.row.kind === 'amrap';
  const target = plannedReps(item.row);
  const [reps, setReps] = useState(entry?.reps ?? target);
  const [weight, setWeight] = useState(entry?.weight ?? planned.weight);
  const [note, setNote] = useState(entry?.note ?? '');
  const [changing, setChanging] = useState(entry?.status === 'changed' || entry?.status === 'skipped');
  const now = () => new Date().toISOString();

  const save = () => {
    const weightChanged = Math.abs(weight - planned.weight) > 1e-9;
    const repsChanged = !amrap && reps !== target;
    onRecord({ status: weightChanged || repsChanged ? 'changed' : 'done', weight, reps, note: note || undefined, at: now() });
  };

  return (
    <div class="actions">
      {amrap && (
        <div class="amrap-input">
          <span>Reps done</span>
          <Stepper value={reps} step={1} min={0} onChange={setReps} big />
          {reps > 0 && <small class="muted">e1RM {kg1(e1rm(weight, reps))}</small>}
        </div>
      )}
      {changing && (
        <div class="change-form">
          <label>Weight <Stepper value={weight} step={2.5} min={0} onChange={setWeight} /></label>
          {!amrap && <label>Reps <Stepper value={reps} step={1} min={0} onChange={setReps} /></label>}
          <input type="text" placeholder="note (optional): why, how it felt…" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
        </div>
      )}
      <div class="btn-row">
        <button class="btn primary" onClick={save}>{changing ? 'Save' : amrap ? `Done · ${reps} reps` : 'Done ✓'}</button>
        {!changing && <button class="btn" onClick={() => setChanging(true)}>Change</button>}
        <button class="btn" onClick={() => onRecord({ status: 'skipped', note: note || undefined, at: now() })}>Skip</button>
        {entry && <button class="btn ghost" onClick={() => onRecord(null)}>Undo</button>}
      </div>
    </div>
  );
}

function AssistanceView({ day, items, session, current, onRound, onExercise }: {
  day: Day; items: (Item & { type: 'round' })[]; session: Session; current: Item | null;
  onRound: (it: Item & { type: 'round' }, done: boolean) => void;
  onExercise: (index: number, name: string, values: { weight: number | null; reps: number | string | null; note?: string }) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  return (
    <section class="card">
      <h2>Assistance {day.assistanceNote && <small class="muted">{day.assistanceNote}</small>}</h2>
      {day.assistance.map((a) => {
        const logged = session.entries[`X:${a.index}`];
        const weight = logged?.weight ?? (typeof a.weight === 'number' ? a.weight : null);
        const reps = logged?.reps ?? a.reps;
        return editing === a.index ? (
          <AssistEditor key={a.index} name={logged?.name ?? a.name} weight={weight} reps={reps}
            onSave={(v) => { onExercise(a.index, v.name, v); setEditing(null); }} onCancel={() => setEditing(null)} />
        ) : (
          <div class="item todo" key={a.index} onClick={() => setEditing(a.index)}>
            <span class="icon">{logged ? '✎' : ''}</span>
            <span class="what">{logged?.name ?? a.name}</span>
            <span class="side">{weight ? `${kg(weight)} kg · ` : ''}{a.sets}×{reps ?? '?'}</span>
          </div>
        );
      })}
      <div class="rounds">
        {items.map((it) => {
          const e = entryFor(it, session, day);
          const isCur = current?.id === it.id;
          return (
            <button id={it.id} key={it.id} class={`round ${e ? 'done' : ''} ${isCur ? 'current' : ''}`} onClick={() => onRound(it, !e)}>
              {e ? '✓' : `R${it.round + 1}`}
            </button>
          );
        })}
      </div>
      <small class="muted">Tap an exercise to log weight/reps or swap it; tap a round when it's done.</small>
    </section>
  );
}

function AssistEditor({ name, weight, reps, onSave, onCancel }: {
  name: string; weight: number | null; reps: number | string | null;
  onSave: (v: { name: string; weight: number | null; reps: number | string | null; note?: string }) => void; onCancel: () => void;
}) {
  const [n, setN] = useState(name);
  const [w, setW] = useState(weight ?? 0);
  const [r, setR] = useState(typeof reps === 'number' ? reps : parseInt(String(reps ?? ''), 10) || 0);
  const [text, setText] = useState(typeof reps === 'string' && Number.isNaN(parseInt(reps, 10)) ? reps : '');
  const [note, setNote] = useState('');
  return (
    <div class="item-card current">
      <input type="text" value={n} onInput={(e) => setN(e.currentTarget.value)} />
      <div class="change-form">
        <label>Weight <Stepper value={w} step={1} min={0} onChange={setW} /></label>
        <label>Reps <Stepper value={r} step={1} min={0} onChange={setR} /></label>
        <input type="text" placeholder="or free text, e.g. 30s" value={text} onInput={(e) => setText(e.currentTarget.value)} />
        <input type="text" placeholder="note (optional)" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      </div>
      <div class="btn-row">
        <button class="btn primary" onClick={() => onSave({ name: n, weight: w || null, reps: text || r, note: note || undefined })}>Save</button>
        <button class="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Stepper({ value, step, min, onChange, big }: { value: number; step: number; min: number; onChange: (v: number) => void; big?: boolean }) {
  return (
    <span class={`stepper ${big ? 'big' : ''}`}>
      <button type="button" onClick={() => onChange(Math.max(min, +(value - step).toFixed(2)))}>−</button>
      <b>{+value.toFixed(2)}</b>
      <button type="button" onClick={() => onChange(+(value + step).toFixed(2))}>+</button>
    </span>
  );
}

function RestTimer({ rest, onChange }: { rest: { endsAt: number; total: number }; onChange: (r: { endsAt: number; total: number } | null) => void }) {
  const [now, setNow] = useState(Date.now());
  const buzzed = useRef(false);
  useEffect(() => {
    buzzed.current = false;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [rest.endsAt]);
  const left = Math.ceil((rest.endsAt - now) / 1000);
  if (left <= 0 && !buzzed.current) {
    buzzed.current = true;
    navigator.vibrate?.([400, 150, 400, 150, 400]);
  }
  const mmss = (s: number) => `${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, '0')}`;
  return (
    <div class={`rest ${left <= 0 ? 'over' : ''}`}>
      <div class="rest-bar" style={{ width: `${Math.max(0, Math.min(1, left / rest.total)) * 100}%` }} />
      <span class="rest-time">{left > 0 ? `Rest ${mmss(left)}` : `Go! (+${mmss(left)})`}</span>
      <button class="btn" onClick={() => onChange({ ...rest, endsAt: rest.endsAt + 30000, total: rest.total + 30 })}>+30s</button>
      <button class="btn ghost" onClick={() => onChange(null)}>✕</button>
    </div>
  );
}

function SyncBadge({ sync }: { sync: SyncState }) {
  if (sync.failed) return <small class="down" title={sync.lastError ?? ''}>⚠ {sync.failed} failed</small>;
  if (sync.pending) return <small class="muted">{sync.flushing ? 'saving…' : navigator.onLine ? `${sync.pending} to save` : `offline · ${sync.pending} waiting`}</small>;
  return <small class="up">✓ saved</small>;
}

function Summary({ data, session, items, day, sync, onClose }: {
  data: Bootstrap; session: Session; items: Item[]; day: Day; sync: SyncState; onClose: () => void;
}) {
  const mins = Math.round((Date.parse(session.finishedAt!) - Date.parse(session.startedAt)) / 60000);
  const setItems = items.filter((it): it is SetItem => it.type === 'set');
  const count = (s: string) => setItems.filter((it) => entryFor(it, session, day)?.status === s).length;
  const deviations = setItems.filter((it) => ['changed', 'skipped'].includes(entryFor(it, session, day)?.status ?? ''));
  const amraps = setItems.filter((it) => it.row.kind === 'amrap' && it.liftRef.key);
  return (
    <main class="session">
      <h1>Workout done 🎉</h1>
      <p class="muted">{mins} min · {count('done')} done · {count('changed')} changed · {count('skipped')} skipped · <SyncBadge sync={sync} /></p>
      {amraps.map((it) => {
        const e = entryFor(it, session, day);
        const key = it.liftRef.key!;
        if (!e || e.status === 'skipped' || e.reps == null) return <p key={it.id} class="muted">{LIFT_LABEL[key]}: AMRAP {e?.status === 'skipped' ? 'skipped' : 'not done'}</p>;
        const w = e.weight ?? it.row.weight;
        const est = e1rm(w, e.reps);
        const list = liftHistory(data.history, key);
        const best = bestE1rm(list);
        const pr = repPrAt(list, w);
        return (
          <section class="card" key={it.id}>
            <h2>{LIFT_LABEL[key]}: {kg(w)} × {e.reps}</h2>
            <div class="facts">
              <span>e1RM <b>{kg1(est)}</b></span>
              {best && est > best.e1rm && <span class="up">★ new e1RM PR (was {kg1(best.e1rm)})</span>}
              {pr && e.reps > pr.reps && <span class="up">★ rep PR at {kg(w)} (was {pr.reps})</span>}
              {best && est <= best.e1rm && <span>{kg1(best.e1rm - est)} kg below best</span>}
            </div>
          </section>
        );
      })}
      {deviations.length > 0 && (
        <section class="card">
          <h2>Off plan</h2>
          {deviations.map((it) => {
            const e = entryFor(it, session, day)!;
            return (
              <div class="row" key={it.id}>
                <span>{LIFT_LABEL[it.liftRef.key ?? ''] ?? it.liftRef.name} {kg(it.row.weight)}×{it.row.reps}</span>
                <span class="muted">{e.status === 'skipped' ? 'skipped' : `${kg(e.weight ?? 0)}×${e.reps}`}{e.note ? ` · ${e.note}` : ''}</span>
              </div>
            );
          })}
        </section>
      )}
      <button class="btn primary" onClick={onClose}>Close</button>
    </main>
  );
}

function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const get = () => navigator.wakeLock.request('screen').then((l) => { lock = l; }).catch(() => {});
    const onVis = () => { if (document.visibilityState === 'visible') void get(); };
    void get();
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); void lock?.release(); };
  }, [active]);
}
