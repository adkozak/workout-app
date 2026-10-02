import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Assistance, Bootstrap, Config, Day } from './api.ts';
import { confetti, restOver, tap, unlockAudio } from './fx.ts';
import { planLoadings, plateSteps, type Inventory, type Loading } from './plates.ts';
import { enqueue as enqueueOps, onSync, syncState, type SyncState } from './queue.ts';
import {
  assistOp, buildItems, currentItem, defaultLiftOrder, effectiveStart, entryFor, extraOp, findDay, finishTime, groupOf, isStale,
  plannedReps, plannedWeight, previousCompletion, REST_SECS, restFor, rmOp, roundOp, setOp, summaryOp, timing, timingWarning,
  tonnage, uuid, type Entry, type Extra, type Item, type Session,
} from './session.ts';
import { bestE1rm, e1rm, liftHistory, repPrAt, repsToBeat, sameWeekIn } from './stats.ts';
import { AmrapPanel, BAR, LIFT_LABEL, LiftHeader, PlateStrip, Plates, Stepper, kg, kg1, shortDate } from './ui.tsx';

type SetItem = Item & { type: 'set' };
type RoundItem = Item & { type: 'round' };
interface Rest { endsAt: number; total: number }
interface Toast { text: string; sub?: string; actions?: { label: string; run: () => void }[] }

interface Props {
  cfg: Config;
  data: Bootstrap;
  session: Session;
  setSession: (s: Session | null) => void;
  inventory: Inventory;
  setInventory: (i: Inventory) => void;
  onClose: () => void;
  /** Loads the sheet again without closing the workout. */
  onReload: () => void;
  syncing: boolean;
  /** Latest heart rate the watch shared, if it is in this workout too. */
  watchHr: { bpm: number; at: string } | null;
}

const liftName = (l: { key: string | null; name: string }) => (l.key ? LIFT_LABEL[l.key] : l.name);
const mins = (secs: number) => Math.round(secs / 60);
const clock = (secs: number) => {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function SessionView({ cfg, data, session, setSession, inventory, setInventory, onClose, onReload, syncing, watchHr }: Props) {
  // A practice workout never writes to the sheet.
  const enqueue: typeof enqueueOps = (c, ...ops) => { if (!session.practice) enqueueOps(c, ...ops); };
  const day = session.cycle === data.cycle.name ? findDay(data.cycle, session.week, session.day) : null;
  const order = session.liftOrder ?? (day ? defaultLiftOrder(day) : []);
  const rounds = session.roundCount ?? day?.rounds.length ?? 0;
  const items = useMemo(() => (day ? buildItems(day, order, rounds) : []), [day, order.join(), rounds]);
  const [editing, setEditing] = useState<string | null>(null);
  const [rest, setRest] = useState<Rest | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [sync, setSync] = useState<SyncState>(syncState());
  useEffect(() => onSync(setSync), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.actions ? 10000 : 5000);
    return () => clearTimeout(t);
  }, [toast]);
  useWakeLock(!session.finishedAt);

  const current = day ? currentItem(items, session, day) : null;
  useEffect(() => {
    const id = editing ?? current?.id;
    if (id) document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [current?.id, editing]);

  if (!day) {
    return (
      <main class="empty">
        <p>This workout ({session.cycle} week {session.week} day {session.day}) is not in what the app loaded ({data.cycle.name}).
          Nothing is lost: finished sets are in the sheet, unsent ones stay queued.
          If the {session.cycle} tab still exists, load the sheet again.</p>
        <button class="btn primary" disabled={syncing} onClick={onReload}>{syncing ? 'Loading…' : 'Load the sheet again'}</button>
        <button class="btn" onClick={() => { setSession(null); onClose(); }}>Discard it</button>
      </main>
    );
  }

  const plannedOf = (it: SetItem) => ({ weight: plannedWeight(it, session, day, data.cycle.tm), reps: it.row.reps });

  // Plate plan per lift, over the weights actually used so far and planned for the rest.
  const lifts = order.map((li) => {
    const lift = day.lifts[li];
    const its = items.filter((it): it is SetItem => it.type === 'set' && it.lift === li + 1);
    const weights = its.map((it) => session.entries[it.id]?.weight ?? plannedOf(it).weight);
    return { li, lift, its, loadings: planLoadings(weights, inventory, BAR) };
  });
  const loadingOf = (it: SetItem): { loading: Loading; prev: number[] } => {
    const l = lifts.find((x) => x.lift === it.liftRef)!;
    const i = l.its.indexOf(it);
    return { loading: l.loadings[i], prev: i > 0 ? l.loadings[i - 1].perSide : [] };
  };

  const opFor = (item: Item, s: Session, entry: Entry | null) => (item.type === 'set'
    ? setOp(item, s, entry, { weight: plannedOf(item).weight, reps: item.row.reps })
    : roundOp(item.round, s, entry, day.rounds.length));

  const record = (item: Item, entry: Entry | null, base = session) => {
    unlockAudio();
    tap();
    const entries = { ...base.entries, [item.id]: entry ?? { status: 'open' as const, at: new Date().toISOString() } };
    // The cursor follows you: after a set done out of order, "next" continues from there;
    // after an undo, the undone set is next.
    const next = { ...base, entries, cursor: item.id };
    setSession(next);
    setEditing(null);
    enqueue(cfg, opFor(item, next, entry));
    if (entry && entry.status !== 'skipped') {
      const secs = restFor(item);
      setRest(secs > 0 ? { endsAt: Date.now() + secs * 1000, total: secs } : null);
    }
    if (item.type === 'set' && item.row.kind === 'amrap' && entry?.reps && entry.status !== 'skipped' && item.liftRef.key) {
      celebrate(item, entry);
    } else if (entry && entry.status !== 'skipped') {
      warn(item, entry, next);
    }
    return next;
  };

  const warn = (item: Item, entry: Entry, s: Session) => {
    const w = timingWarning(item, timing(s, entry.at, item.id).secsSincePrevious, items, s, day);
    if (w?.kind === 'double') {
      setToast({
        text: `Two sets ${w.secs} s apart`, sub: 'Double tap?',
        actions: [{ label: 'Undo last', run: () => { record(item, null, s); setRest(null); } }],
      });
    } else if (w?.kind === 'missed') {
      const mid = new Date((Date.parse(previousCompletion(s, entry.at, item.id)) + Date.parse(entry.at)) / 2).toISOString();
      setToast({
        text: `${clock(w.secs)} since the last one`, sub: 'Did you do two without tapping?',
        actions: [{ label: 'Mark one more done', run: () => { record(w.next, { status: 'done', at: mid, weight: w.next.type === 'set' ? plannedOf(w.next).weight : undefined, reps: w.next.type === 'set' ? plannedReps(w.next.row) : undefined }, s); } }],
      });
    }
  };

  const addExtra = (x: Omit<Extra, 'id' | 'at'>, exercise: string) => {
    tap();
    const extra: Extra = { ...x, id: `X+${uuid().slice(0, 8)}`, at: new Date().toISOString() };
    const next = { ...session, extras: [...(session.extras ?? []), extra] };
    setSession(next);
    enqueue(cfg, extraOp(extra, next, exercise));
    const secs = REST_SECS;
    setRest({ endsAt: Date.now() + secs * 1000, total: secs });
  };
  const removeExtra = (x: Extra, exercise: string) => {
    const next = {
      ...session,
      extras: (session.extras ?? []).filter((e) => e.id !== x.id),
      removedExtras: [...(session.removedExtras ?? []), x.id], // so the watch's copy doesn't bring it back
    };
    setSession(next);
    enqueue(cfg, extraOp(x, next, exercise, true));
  };
  const togglePause = (group: string) => {
    const paused = session.paused ?? [];
    setSession({ ...session, paused: paused.includes(group) ? paused.filter((g) => g !== group) : [...paused, group] });
  };

  const celebrate = (item: SetItem, entry: Entry) => {
    const list = liftHistory(data.history, item.liftRef.key!);
    const w = entry.weight ?? plannedOf(item).weight;
    const est = e1rm(w, entry.reps!);
    const best = bestE1rm(list);
    const pr = repPrAt(list, w);
    if (best && est > best.e1rm) {
      confetti();
      setToast({ text: `New ${liftName(item.liftRef)} e1RM PR: ${kg1(est)}`, sub: `previous best ${kg1(best.e1rm)} · +${kg1(est - best.e1rm)} kg` });
    } else if (pr && entry.reps! > pr.reps) {
      confetti();
      setToast({ text: `Rep PR: ${kg(w)} × ${entry.reps}`, sub: `previous ${pr.reps} reps` });
    } else if (best) {
      setToast({ text: `e1RM ${kg1(est)}`, sub: `${kg1(best.e1rm - est)} kg below your best` });
    }
  };

  const finish = () => {
    const op = rmOp(items, session, day);
    if (op) enqueue(cfg, op);
    setSession({ ...session, finishedAt: finishTime(session) });
    setRest(null);
  };
  /** Leaving keeps what was logged; AMRAPs also go to rm calc so stats and history see them. */
  const leave = () => {
    const op = rmOp(items, session, day);
    if (op) enqueue(cfg, op);
    setSession(null);
    onClose();
  };

  if (session.finishedAt) {
    return (
      <Summary data={data} session={session} items={items} day={day} sync={sync} onClose={(rpe, note) => {
        const secs = (Date.parse(session.finishedAt!) - Date.parse(effectiveStart(session))) / 1000;
        enqueue(cfg, summaryOp(session, { secs, tonnage: tonnage(items, session) }, rpe, note));
        setSession(null);
        onClose();
      }} />
    );
  }

  const doneCount = items.filter((it) => entryFor(it, session, day)).length;
  const pausedLeft = !current && items.some((it) => !entryFor(it, session, day));
  const loggedAnything = Object.keys(session.entries).length > 0;
  const nextPreview = current?.type === 'set'
    ? <NextSet item={current} planned={plannedOf(current)} {...loadingOf(current)} />
    : current ? <span>Assistance round {current.round + 1}</span> : <span>{pausedLeft ? 'Only paused exercises left' : 'All done: finish when ready'}</span>;

  return (
    <main class="session">
      <header class="session-head">
        <div>
          <h1>W{session.week} · D{session.day}</h1>
          <small>{order.map((li) => liftName(day.lifts[li])).join(' → ')}</small>
        </div>
        <div class="progress-wrap">
          <span>{doneCount}/{items.length}</span>
          {session.practice ? <small class="practice-tag">PRACTICE · nothing is saved</small> : <SyncBadge sync={sync} />}
        </div>
        <div class="progress"><div style={{ width: `${(doneCount / items.length) * 100}%` }} /></div>
        <LiveStats session={session} items={items} day={day} watchHr={watchHr} />
      </header>

      {isStale(session) && (
        <section class="card stale">
          <p>This workout is from <b>{shortDate(session.date)}</b> and was never finished.</p>
          <div class="btn-row">
            <button class="btn primary" onClick={finish}>Finish it</button>
            <button class="btn" onClick={() => { if (confirm('Leave it? What you logged stays in the sheet.')) leave(); }}>Leave it</button>
          </div>
          <small class="muted">Finishing ends it at its last logged set.</small>
        </section>
      )}

      <PlateStrip inventory={inventory} onChange={setInventory} />

      {lifts.map(({ li, lift, its }, pos) => {
        const group = `L${li + 1}`;
        const paused = session.paused?.includes(group) ?? false;
        const extras = (session.extras ?? []).filter((x) => x.group === group);
        const lastWeight = [...its].reverse().map((it) => entryFor(it, session, day)).find((e) => e?.weight)?.weight ?? its[its.length - 1]?.row.weight ?? 20;
        return (
        <section class={`card ${paused ? 'paused' : ''}`} key={lift.name}>
          <div class="lift-bar">
            <h2>{liftName(lift)} <small class="muted">TM {kg(data.cycle.tm[lift.key!] ?? 0)}</small></h2>
            <span class="lift-buttons">
              {pos === 0 && order.length > 1 && (
                <button class="btn small ghost" onClick={() => setSession({ ...session, liftOrder: [...order].reverse() })}>
                  ⇅ {liftName(day.lifts[order[1]])} first
                </button>
              )}
              <button class="btn small ghost" onClick={() => togglePause(group)}>{paused ? '▶ Resume' : '⏸ Pause'}</button>
            </span>
          </div>
          {paused && <small class="muted">Paused: the next set comes from the other exercises until you resume.</small>}
          <LiftHeader lift={lift} list={lift.key ? liftHistory(data.history, lift.key) : []} data={data} hideTitle />
          <LiftTime session={session} its={its} />
          {its.map((it) => {
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
                {...loadingOf(it)}
                data={data}
                week={session.week}
                onRecord={(e) => record(it, e)}
                onEdit={() => setEditing(open ? null : it.id)}
                onDoNext={() => { setSession({ ...session, cursor: it.id, paused: (session.paused ?? []).filter((g) => g !== groupOf(it)) }); setEditing(null); }}
              />
            );
          })}
          {extras.map((x) => (
            <div class="item extra" key={x.id} onClick={() => { if (confirm(`Remove extra set ${kg(x.weight ?? 0)} × ${x.reps}?`)) removeExtra(x, lift.key ?? lift.name); }}>
              <span class="icon">✚</span>
              <span class="what"><b>{kg(x.weight ?? 0)}</b> × {x.reps} <small class="muted">{x.label}{x.note ? ` · ${x.note}` : ''}</small></span>
              <span class="side">extra</span>
            </div>
          ))}
          <ExtraSetButton defaultWeight={lastWeight} onAdd={(w, r, note) => addExtra({ group, label: 'extra set', weight: w, reps: r, note }, lift.key ?? lift.name)} />
        </section>
        );
      })}

      {day.assistance.length > 0 && (
        <AssistanceView
          day={day}
          lastTime={previousAssistance(data, session.week, session.day)}
          items={items.filter((it): it is RoundItem => it.type === 'round')}
          session={session}
          current={current}
          onRound={(it, entry) => record(it, entry)}
          rounds={rounds}
          onRounds={(n) => setSession({ ...session, roundCount: n })}
          paused={session.paused?.includes('A') ?? false}
          onPause={() => togglePause('A')}
          onExercise={(index, name, values) => {
            const entry: Entry = {
              status: 'done', at: new Date().toISOString(), name,
              weight: values.weight ?? undefined, reps: typeof values.reps === 'number' ? values.reps : undefined, note: values.note,
            };
            const next = { ...session, entries: { ...session.entries, [`X:${index}`]: entry } };
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
      <button class="btn ghost wide" onClick={() => {
        if (confirm(loggedAnything ? 'Leave this workout? What you logged stays in the sheet.' : 'Leave this workout?')) leave();
      }}>
        Leave without finishing
      </button>

      {toast && (
        <div class="toast" onClick={() => setToast(null)}>
          <b>{toast.text}</b>
          {toast.sub && <small>{toast.sub}</small>}
          {toast.actions && (
            <div class="btn-row">
              {toast.actions.map((a) => <button key={a.label} class="btn primary" onClick={(e) => { e.stopPropagation(); a.run(); setToast(null); }}>{a.label}</button>)}
              <button class="btn ghost">Keep</button>
            </div>
          )}
        </div>
      )}
      {rest && <RestTimer rest={rest} onChange={setRest}>{nextPreview}</RestTimer>}
    </main>
  );
}

/** Elapsed time, kg moved, and when you'll be done at the current pace. */
function LiveStats({ session, items, day, watchHr }: { session: Session; items: Item[]; day: Day; watchHr: Props['watchHr'] }) {
  const now = useNow();
  const hr = watchHr && now - Date.parse(watchHr.at) < 60000 ? watchHr.bpm : null;
  const elapsed = (now - Date.parse(effectiveStart(session))) / 1000;
  const completions = Object.values(session.entries).filter((e) => e.status !== 'open' && e.at).length + (session.extras?.length ?? 0);
  const remaining = items.filter((it) => !entryFor(it, session, day));
  const pace = completions >= 3 ? elapsed / completions : null;
  const left = remaining.reduce((t, it) => t + (pace ?? restFor(it) + 40), 0);
  const eta = new Date(now + left * 1000);
  return (
    <div class="live">
      <span>⏱ <b>{clock(elapsed)}</b></span>
      {hr != null && <span>⌚ ♥ <b>{hr}</b></span>}
      <span>🏋 <b>{Math.round(tonnage(items, session)).toLocaleString()}</b> kg moved</span>
      {remaining.length > 0 && <span>~{mins(left)} min left · done {eta.getHours()}:{String(eta.getMinutes()).padStart(2, '0')}</span>}
    </div>
  );
}

/** How long this lift has taken so far. */
function LiftTime({ session, its }: { session: Session; its: SetItem[] }) {
  const times = its.map((it) => session.entries[it.id]).filter((e) => e && e.status !== 'open' && e.at).map((e) => e!.at).sort();
  if (times.length < 2) return null;
  const first = its.map((it) => session.entries[it.id]).find((e) => e?.at === times[0]);
  const start = first ? previousCompletion(session, times[0]) : times[0];
  const secs = (Date.parse(times[times.length - 1]) - Date.parse(start)) / 1000;
  return <small class="muted lift-time">{mins(secs)} min on this lift so far</small>;
}

function PlateStepsView({ from, to }: { from: number[]; to: number[] }) {
  const { remove, add } = plateSteps(from, to);
  if (!remove.length && !add.length) return <span class="steps muted">{to.length ? 'plates stay' : 'empty bar'}</span>;
  return (
    <span class="steps">
      {remove.map((p, i) => <span key={`r${i}`} class="step off">−{p}</span>)}
      {add.map((p, i) => <span key={`a${i}`} class="step on">+{p}</span>)}
      <small class="muted"> each side</small>
    </span>
  );
}

function NextSet({ item, planned, loading, prev }: { item: SetItem; planned: { weight: number; reps: string }; loading: Loading; prev: number[] }) {
  const perSide = (loading.total - BAR) / 2;
  return (
    <span class="next-set">
      <small class="muted">Next · {liftName(item.liftRef)}</small>
      <span><b>{kg(planned.weight)}</b> × {planned.reps} · {perSide > 0 ? `${kg(perSide)}/side` : 'bar'}</span>
      <PlateStepsView from={prev} to={loading.perSide} />
    </span>
  );
}

function SetItemView({ item, entry, open, isCurrent, planned, loading, prev, data, week, onRecord, onEdit, onDoNext }: {
  item: SetItem; entry: Entry | null; open: boolean; isCurrent: boolean;
  planned: { weight: number; reps: string }; loading: Loading; prev: number[];
  data: Bootstrap; week: number; onRecord: (e: Entry | null) => void; onEdit: () => void; onDoNext: () => void;
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
      <div class="load-row">
        <Plates loading={loading} />
        <PlateStepsView from={prev} to={loading.perSide} />
      </div>
      {!isCurrent && !entry && (
        <button class="btn wide do-next" onClick={onDoNext}>▶ Do this next <small>(the app continues from here)</small></button>
      )}
      <SetActions item={item} entry={entry} planned={planned} data={data} week={week} onRecord={onRecord} />
      {row.kind === 'amrap' && item.liftRef.key && (
        <details class="amrap-details">
          <summary>Rep table & history</summary>
          <AmrapPanel set={{ ...row, weight: planned.weight }} lift={item.liftRef} liftKey={item.liftRef.key} list={liftHistory(data.history, item.liftRef.key)} week={week} data={data} />
        </details>
      )}
    </div>
  );
}

function SetActions({ item, entry, planned, data, week, onRecord }: {
  item: SetItem; entry: Entry | null; planned: { weight: number; reps: string };
  data: Bootstrap; week: number; onRecord: (e: Entry | null) => void;
}) {
  const amrap = item.row.kind === 'amrap';
  const target = plannedReps(item.row);
  const key = item.liftRef.key;
  // Start the AMRAP counter at what you did last cycle in this week, so it's a few taps either way.
  const lastCycle = amrap && key ? sameWeekIn(data.previous, week, key) : null;
  const [reps, setReps] = useState(entry?.reps ?? (amrap ? Math.max(target, lastCycle?.reps ?? target) : target));
  const [weight, setWeight] = useState(entry?.weight ?? planned.weight);
  const [note, setNote] = useState(entry?.note ?? '');
  const [changing, setChanging] = useState(entry?.status === 'changed' || entry?.status === 'skipped');
  const now = () => new Date().toISOString();

  const list = amrap && key ? liftHistory(data.history, key) : [];
  const best = bestE1rm(list);
  const pr = repPrAt(list, weight);
  const est = e1rm(weight, reps);
  const lastTime = list[list.length - 1];
  const match = (target: number) => repsToBeat(target - 1e-6, weight);
  // Rep ladder: what each target takes at today's weight, ticked as the counter passes it.
  const ladder = amrap ? [
    lastTime && { label: `match last time (${kg(lastTime.weight)}×${lastTime.reps}, ${shortDate(lastTime.date)})`, reps: match(lastTime.e1rm) },
    lastCycle && { label: `match last cycle wk${week} (${kg(lastCycle.weight)}×${lastCycle.reps})`, reps: match(e1rm(lastCycle.weight, lastCycle.reps)) },
    pr && { label: `rep PR at ${kg(weight)} (was ${pr.reps})`, reps: pr.reps + 1 },
    best && { label: `e1RM PR (${kg1(best.e1rm)})`, reps: repsToBeat(best.e1rm, weight), gold: true },
  ].filter((x): x is { label: string; reps: number; gold?: boolean } => !!x).sort((a, b) => a.reps - b.reps) : [];

  const save = () => {
    const weightChanged = Math.abs(weight - planned.weight) > 1e-9;
    const repsChanged = !amrap && reps !== target;
    onRecord({ status: weightChanged || repsChanged ? 'changed' : 'done', weight, reps, note: note || undefined, at: now() });
  };

  return (
    <div class="actions">
      {amrap && (
        <div class="amrap-input">
          <Stepper value={reps} step={1} min={0} onChange={(v) => { tap(); setReps(v); }} big />
          <div class="amrap-live">
            <span>e1RM <b>{kg1(est)}</b></span>
            {best && est > best.e1rm && <span class="badge gold">★ e1RM PR</span>}
            {pr && reps > pr.reps && <span class="badge">rep PR</span>}
          </div>
        </div>
      )}
      {ladder.length > 0 && (
        <ul class="ladder">
          {ladder.map((t) => (
            <li key={t.label} class={reps >= t.reps ? (t.gold ? 'hit gold' : 'hit') : ''} onClick={() => setReps(t.reps)}>
              <b>{t.reps}</b> <span>{t.label}</span> <span class="tick">{reps >= t.reps ? '✓' : ''}</span>
            </li>
          ))}
        </ul>
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

/** Assistance values from the same day last week (or week 3 of the previous cycle). */
function previousAssistance(data: Bootstrap, week: number, day: number): Assistance[] {
  const src = week > 1 ? findDay(data.cycle, week - 1, day) : data.previous ? findDay(data.previous, 3, day) : null;
  return src?.assistance ?? [];
}

function AssistanceView({ day, lastTime, items, session, current, onRound, onExercise, rounds, onRounds, paused, onPause }: {
  day: Day; lastTime: Assistance[]; items: RoundItem[]; session: Session; current: Item | null;
  onRound: (it: RoundItem, entry: Entry | null) => void;
  onExercise: (index: number, name: string, values: { weight: number | null; reps: number | string | null; note?: string }) => void;
  rounds: number; onRounds: (n: number) => void; paused: boolean; onPause: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [openRound, setOpenRound] = useState<RoundItem | null>(null);
  const exercises = day.assistance.map((a) => {
    const logged = session.entries[`X:${a.index}`];
    return { a, name: logged?.name ?? a.name, weight: logged?.weight ?? (typeof a.weight === 'number' ? a.weight : null), reps: logged?.reps ?? a.reps };
  });
  const doneRounds = items.filter((it) => entryFor(it, session, day)).length;
  const roundTarget = current?.type === 'round' ? current : null;

  return (
    <section class={`card ${paused ? 'paused' : ''}`}>
      <div class="lift-bar">
        <h2>Assistance {day.assistanceNote && <small class="muted">{day.assistanceNote}</small>}</h2>
        <button class="btn small ghost" onClick={onPause}>{paused ? '▶ Resume' : '⏸ Pause'}</button>
      </div>
      {exercises.map(({ a, name, weight, reps }) => {
        const logged = session.entries[`X:${a.index}`];
        const prev = lastTime.find((p) => p.index === a.index && p.name.toLowerCase() === name.toLowerCase());
        return editing === a.index ? (
          <AssistEditor key={a.index} name={name} weight={weight} reps={reps}
            onSave={(v) => { onExercise(a.index, v.name, v); setEditing(null); }} onCancel={() => setEditing(null)} />
        ) : (
          <div class="item todo" key={a.index} onClick={() => setEditing(a.index)}>
            <span class="icon">{logged ? '✎' : ''}</span>
            <span class="what">
              {name}
              {prev && (prev.weight || prev.reps) && <small class="muted"> · last {prev.weight ? `${prev.weight} kg × ` : ''}{prev.reps}</small>}
            </span>
            <span class="side">{weight ? `${kg(weight)} kg · ` : ''}{a.sets}×{reps ?? '?'}</span>
          </div>
        );
      })}
      <div class="rounds">
        {items.map((it) => {
          const e = entryFor(it, session, day);
          return (
            <button id={it.id} key={it.id} class={`round ${e ? 'done' : ''} ${roundTarget?.id === it.id ? 'current' : ''} ${openRound?.id === it.id ? 'open' : ''}`}
              onClick={() => {
                if (e) { if (confirm(`Undo round ${it.round + 1}?`)) onRound(it, null); }
                else setOpenRound(openRound?.id === it.id ? null : it);
              }}>
              {e ? '✓' : `R${it.round + 1}`}
            </button>
          );
        })}
        <button class="round adjust" disabled={rounds <= Math.max(1, doneRounds)} onClick={() => onRounds(rounds - 1)}>−</button>
        <button class="round adjust" disabled={rounds >= 10} onClick={() => onRounds(rounds + 1)}>+</button>
      </div>
      {(openRound ?? roundTarget) && !paused && (
        <RoundEditor key={(openRound ?? roundTarget)!.id} round={(openRound ?? roundTarget)!} exercises={exercises}
          onDone={(detail) => { onRound((openRound ?? roundTarget)!, { status: 'done', at: new Date().toISOString(), detail }); setOpenRound(null); }} />
      )}
      <small class="muted">Tap an exercise to change its weight/reps for the day or swap it. Rounds past 5 go to the session log only.</small>
    </section>
  );
}

/** Log a round: one tap if it went as planned, or adjust reps per exercise first. */
function RoundEditor({ round, exercises, onDone }: {
  round: RoundItem;
  exercises: { a: Assistance; name: string; reps: number | string | null }[];
  onDone: (detail: Entry['detail']) => void;
}) {
  const numeric = (r: number | string | null) => (typeof r === 'number' ? r : parseInt(String(r ?? ''), 10));
  const [reps, setReps] = useState(exercises.map((x) => numeric(x.reps)));
  const [adjusting, setAdjusting] = useState(false);
  const detail = exercises
    .map((x, i) => ({ index: x.a.index, planned: numeric(x.reps), reps: reps[i] }))
    .filter((d) => !Number.isNaN(d.reps) && d.reps !== d.planned)
    .map(({ index, reps: r }) => ({ index, reps: r }));
  return (
    <div class="item-card current round-editor">
      {adjusting && exercises.map((x, i) => (
        <label class="round-row" key={x.a.index}>
          <span>{x.name}</span>
          {Number.isNaN(reps[i]) ? <small class="muted">{x.reps}</small>
            : <Stepper value={reps[i]} step={1} min={0} onChange={(v) => setReps(reps.map((r, j) => (j === i ? v : r)))} />}
        </label>
      ))}
      <div class="btn-row">
        <button class="btn primary" onClick={() => onDone(detail.length ? detail : undefined)}>
          ✓ Round {round.round + 1}{adjusting ? (detail.length ? ' with these reps' : ' as planned') : ' done'}
        </button>
        {!adjusting && <button class="btn" onClick={() => setAdjusting(true)}>Reps…</button>}
      </div>
    </div>
  );
}

function ExtraSetButton({ defaultWeight, onAdd }: { defaultWeight: number; onAdd: (weight: number, reps: number, note: string) => void }) {
  const [open, setOpen] = useState(false);
  const [w, setW] = useState(defaultWeight);
  const [r, setR] = useState(5);
  const [note, setNote] = useState('');
  if (!open) return <button class="btn small ghost add-extra" onClick={() => { setW(defaultWeight); setOpen(true); }}>+ extra set</button>;
  return (
    <div class="item-card current">
      <div class="change-form">
        <label>Weight <Stepper value={w} step={2.5} min={0} onChange={setW} /></label>
        <label>Reps <Stepper value={r} step={1} min={0} onChange={setR} /></label>
        <input type="text" placeholder="note (optional): back-off, extra 5×5 set…" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      </div>
      <div class="btn-row">
        <button class="btn primary" onClick={() => { onAdd(w, r, note); setOpen(false); setNote(''); }}>Add set ✓</button>
        <button class="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
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

function RestTimer({ rest, onChange, children }: { rest: Rest; onChange: (r: Rest | null) => void; children: ComponentChildren }) {
  const now = useNow(250);
  const buzzed = useRef(false);
  useEffect(() => { buzzed.current = false; }, [rest.endsAt]);
  const left = Math.ceil((rest.endsAt - now) / 1000);
  if (left <= 0 && !buzzed.current) {
    buzzed.current = true;
    restOver();
  }
  return (
    <div class={`rest ${left <= 0 ? 'over' : ''}`}>
      <div class="rest-bar" style={{ width: `${Math.max(0, Math.min(1, left / rest.total)) * 100}%` }} />
      <div class="rest-main">
        <span class="rest-time">{left > 0 ? clock(left) : `Go! +${clock(-left)}`}</span>
        <button class="btn" onClick={() => onChange({ ...rest, endsAt: rest.endsAt + 30000, total: rest.total + 30 })}>+30s</button>
        <button class="btn ghost" onClick={() => onChange(null)}>✕</button>
      </div>
      <div class="rest-next">{children}</div>
    </div>
  );
}

function SyncBadge({ sync }: { sync: SyncState }) {
  if (sync.failed) return <small class="down" title={sync.lastError ?? ''}>⚠ {sync.failed} failed</small>;
  if (sync.pending) return <small class="muted">{sync.flushing ? 'saving…' : navigator.onLine ? `${sync.pending} to save` : `offline · ${sync.pending} waiting`}</small>;
  return <small class="up">✓ saved</small>;
}

/** Durations per phase (warm-up, main, 5×5, assistance) from completion timestamps. */
function phaseTimes(session: Session, items: Item[]): { label: string; secs: number }[] {
  const out = new Map<string, number>();
  for (const it of items) {
    const e = session.entries[it.id];
    if (!e || e.status === 'open' || !e.at) continue;
    const secs = (Date.parse(e.at) - Date.parse(previousCompletion(session, e.at, it.id))) / 1000;
    const label = it.type === 'round' ? 'Assistance'
      : `${liftName(it.liftRef)} ${it.row.kind === 'warmup' ? 'warm-up' : it.row.kind === 'supplemental' ? '5×5' : 'main + AMRAP'}`;
    out.set(label, (out.get(label) ?? 0) + secs);
  }
  return [...out].map(([label, secs]) => ({ label, secs }));
}

/** Total length of earlier logged workouts, from the session log's timing columns. */
function pastDurations(data: Bootstrap): { date: string; secs: number }[] {
  const byDate = new Map<string, number>();
  for (const row of data.history.log) {
    const date = String(row['session date'] ?? '').slice(0, 10);
    const secs = Number(row['secs since start']);
    if (date && secs > 0) byDate.set(date, Math.max(byDate.get(date) ?? 0, secs));
  }
  return [...byDate].map(([date, secs]) => ({ date, secs })).sort((a, b) => a.date.localeCompare(b.date));
}

const RPE_LABELS: Record<number, string> = {
  5: 'easy', 6: 'moderate', 7: 'hard, lots left', 8: 'hard', 9: 'very hard', 10: 'max',
};

function Summary({ data, session, items, day, sync, onClose }: {
  data: Bootstrap; session: Session; items: Item[]; day: Day; sync: SyncState; onClose: (rpe: number | null, note: string) => void;
}) {
  const [rpe, setRpe] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const total = (Date.parse(session.finishedAt!) - Date.parse(effectiveStart(session))) / 1000;
  const setItems = items.filter((it): it is SetItem => it.type === 'set');
  const count = (s: string) => setItems.filter((it) => entryFor(it, session, day)?.status === s).length;
  const deviations = setItems.filter((it) => ['changed', 'skipped'].includes(entryFor(it, session, day)?.status ?? ''));
  const amraps = setItems.filter((it) => it.row.kind === 'amrap' && it.liftRef.key);
  const phases = phaseTimes(session, items);
  const maxPhase = Math.max(1, ...phases.map((p) => p.secs));
  const past = pastDurations(data).filter((p) => p.date !== session.date);
  const lastDuration = past[past.length - 1];
  const supp = setItems.filter((it) => it.row.kind === 'supplemental' && it.sub > 0 && session.entries[it.id]?.at)
    .map((it) => (Date.parse(session.entries[it.id].at) - Date.parse(previousCompletion(session, session.entries[it.id].at, it.id))) / 1000);
  const avgSupp = supp.length ? supp.reduce((a, b) => a + b, 0) / supp.length : null;

  return (
    <main class="session">
      <h1>Workout done 🎉</h1>
      <div class="facts big-facts">
        <span>⏱ <b>{mins(total)}</b> min</span>
        <span>🏋 <b>{Math.round(tonnage(items, session)).toLocaleString()}</b> kg moved</span>
        <span>✓ {count('done')} · ✎ {count('changed')} · ⤼ {count('skipped')}</span>
        {session.hr && <span>♥ avg <b>{session.hr.avg}</b> · max <b>{session.hr.max}</b></span>}
        {session.practice ? <small class="practice-tag">PRACTICE · nothing is saved</small> : <SyncBadge sync={sync} />}
      </div>

      {amraps.map((it) => {
        const e = entryFor(it, session, day);
        const key = it.liftRef.key!;
        if (!e || e.status === 'skipped' || e.reps == null) return <p key={it.id} class="muted">{LIFT_LABEL[key]}: AMRAP {e?.status === 'skipped' ? 'skipped' : 'not done'}</p>;
        const w = e.weight ?? it.row.weight;
        const est = e1rm(w, e.reps);
        const list = liftHistory(data.history, key);
        const best = bestE1rm(list);
        const pr = repPrAt(list, w);
        const lastCycle = sameWeekIn(data.previous, session.week, key);
        return (
          <section class="card" key={it.id}>
            <h2>{LIFT_LABEL[key]}: {kg(w)} × {e.reps}</h2>
            <div class="facts">
              <span>e1RM <b>{kg1(est)}</b></span>
              {best && est > best.e1rm && <span class="badge gold">★ new e1RM PR (was {kg1(best.e1rm)})</span>}
              {pr && e.reps > pr.reps && <span class="badge">★ rep PR at {kg(w)} (was {pr.reps})</span>}
              {best && est <= best.e1rm && <span>{kg1(best.e1rm - est)} kg below best</span>}
              {lastCycle && (
                <span>last cycle: {kg(lastCycle.weight)} × {lastCycle.reps} ({(() => {
                  const d = est - e1rm(lastCycle.weight, lastCycle.reps);
                  return `${d >= 0 ? '+' : '−'}${kg1(Math.abs(d))} e1RM`;
                })()})</span>
              )}
            </div>
          </section>
        );
      })}

      <section class="card">
        <h2>Where the time went</h2>
        {phases.map((p) => (
          <div class="phase" key={p.label}>
            <span>{p.label}</span>
            <span class="phase-bar"><span style={{ width: `${(p.secs / maxPhase) * 100}%` }} /></span>
            <span class="muted">{clock(p.secs)}</span>
          </div>
        ))}
        <div class="facts">
          {avgSupp != null && <span>avg 5×5 set + rest <b>{clock(avgSupp)}</b></span>}
          {lastDuration && <span>last logged workout {mins(lastDuration.secs)} min</span>}
        </div>
      </section>

      {deviations.length > 0 && (
        <section class="card">
          <h2>Off plan</h2>
          {deviations.map((it) => {
            const e = entryFor(it, session, day)!;
            return (
              <div class="row" key={it.id}>
                <span>{liftName(it.liftRef)} {kg(it.row.weight)}×{it.row.reps}</span>
                <span class="muted">{e.status === 'skipped' ? 'skipped' : `${kg(e.weight ?? 0)}×${e.reps}`}{e.note ? ` · ${e.note}` : ''}</span>
              </div>
            );
          })}
        </section>
      )}
      {(session.extras?.length ?? 0) > 0 && (
        <section class="card">
          <h2>Extra</h2>
          {session.extras!.map((x) => (
            <div class="row" key={x.id}><span>{x.group === 'A' ? 'Assistance' : liftName(day.lifts[Number(x.group.slice(1)) - 1])} {x.label}</span><span class="muted">{kg(x.weight ?? 0)}×{x.reps}{x.note ? ` · ${x.note}` : ''}</span></div>
          ))}
        </section>
      )}

      <section class="card">
        <h2>How hard was it overall?</h2>
        <div class="rpe">
          {[5, 6, 7, 8, 9, 10].map((n) => (
            <button key={n} class={`rpe-btn ${rpe === n ? 'on' : ''}`} onClick={() => { tap(); setRpe(rpe === n ? null : n); }}>
              <b>{n}</b><small>{RPE_LABELS[n]}</small>
            </button>
          ))}
        </div>
        <input class="text-input" type="text" placeholder="How did it feel? sleep, energy, pain… (optional)" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      </section>
      <button class="btn primary wide" onClick={() => onClose(rpe, note)}>{rpe || note ? 'Save & close' : 'Close'}</button>
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
