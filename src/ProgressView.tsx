import { useMemo, useState } from 'preact/hooks';
import type { Archive, Bootstrap, LiftKey } from './api.ts';
import { LevelMeter, MonthBars, ProgressChart, type Point } from './charts.tsx';
import {
  amrapGrid, currentE1rm, overview, repPrBoard, stalled, standardsProgress, type AssistDone, type PastSession,
} from './history.ts';
import { bestE1rm, daysBetween, liftHistory, trend } from './stats.ts';
import { LIFT_LABEL, Stepper, kg, kg1, shortDate } from './ui.tsx';

const LIFTS: LiftKey[] = ['squat', 'bench', 'deadlift', 'press', 'wide_bench'];
const tons = (kgs: number) => `${(kgs / 1000).toFixed(1)} t`;
const months = (days: number) => (days < 60 ? `${days} days` : days < 730 ? `${Math.round(days / 30)} months` : `${(days / 365).toFixed(1)} years`);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const OCTAVIA = 1400; // kg, for scale

interface Props {
  data: Bootstrap;
  archive: Archive | null;
  sessions: PastSession[];
  assist: Map<string, AssistDone[]>;
  today: string;
  onBodyweight: (kg: number) => void;
}

export function ProgressView({ data, archive, sessions, assist, today, onBodyweight }: Props) {
  return (
    <>
      <Overview sessions={sessions} today={today} />
      <Targets data={data} sessions={sessions} assist={assist} today={today} onBodyweight={onBodyweight} />
      <LiftProgress data={data} archive={archive} sessions={sessions} today={today} />
    </>
  );
}

function Overview({ sessions, today }: { sessions: PastSession[]; today: string }) {
  const o = useMemo(() => overview(sessions, today), [sessions, today]);
  const amraps = sessions.flatMap((s) => s.amraps.map((a) => ({ ...a, date: s.date })));
  const mostReps = amraps.reduce<(typeof amraps)[number] | null>((b, a) => (!b || a.reps > b.reps ? a : b), null);
  const heaviest = amraps.reduce<(typeof amraps)[number] | null>((b, a) => (!b || a.weight > b.weight ? a : b), null);
  const days = new Array(7).fill(0);
  sessions.forEach((s) => { if (s.date) days[new Date(`${s.date}T12:00:00Z`).getUTCDay()]++; });
  const favDay = days.indexOf(Math.max(...days));
  const longestBreak = o.breaks.reduce<(typeof o.breaks)[number] | null>((b, x) => (!b || x.days > b.days ? x : b), null);
  const last = sessions.filter((s) => s.date).pop();
  return (
    <section class="card">
      <h2>{o.first ? `Since ${shortDate(o.first)}` : 'Overview'}</h2>
      <div class="tiles">
        <div class="tile"><small>workouts</small><b>{o.sessions}</b><small>{o.first ? months(daysBetween(o.first, today)) : ''}</small></div>
        <div class="tile"><small>weekly streak</small><b>{o.currentStreakWeeks}</b><small>best {o.longestStreakWeeks} weeks</small></div>
        <div class="tile"><small>moved</small><b>{tons(o.tonnage)}</b><small>since {o.tonnageSince ? shortDate(o.tonnageSince) : '–'}</small></div>
        <div class="tile"><small>e1RM PRs</small><b>{o.prs}</b><small>{o.prsThisYear} this year</small></div>
      </div>
      <h3>Workouts per month</h3>
      <MonthBars months={o.perMonth} />
      <ul class="facts-list">
        {last?.date && <li>Last workout {shortDate(last.date)}, {daysBetween(last.date, today)} days ago.</li>}
        <li>{o.amraps} AMRAPs, {o.amrapReps} AMRAP reps in total.</li>
        {o.tonnage > 0 && <li>{tons(o.tonnage)} on the bar ≈ {Math.round(o.tonnage / OCTAVIA)} Škoda Octavias.</li>}
        {mostReps && <li>Most reps in one AMRAP: {LIFT_LABEL[mostReps.key]} {kg(mostReps.weight)}×{mostReps.reps}{mostReps.date ? ` (${shortDate(mostReps.date)})` : ''}.</li>}
        {heaviest && <li>Heaviest AMRAP: {LIFT_LABEL[heaviest.key]} {kg(heaviest.weight)} kg.</li>}
        {o.avgSecs && <li>Average workout {Math.round(o.avgSecs / 60)} min ({o.timedSessions} timed by the app).</li>}
        <li>Favourite day: {WEEKDAYS[favDay]} ({days[favDay]} workouts).</li>
        {longestBreak && (
          <li>{o.breaks.length} breaks over 2 weeks; the longest {longestBreak.days} days ({shortDate(longestBreak.from)} – {shortDate(longestBreak.to)}).</li>
        )}
      </ul>
    </section>
  );
}

function Targets({ data, sessions, assist, today, onBodyweight }: {
  data: Bootstrap; sessions: PastSession[]; assist: Map<string, AssistDone[]>; today: string; onBodyweight: (kg: number) => void;
}) {
  const bw = data.cycle.bodyweight;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bw ?? 75);
  const std = data.cycle.standards;
  const rows = useMemo(() => (std && bw ? standardsProgress(std, bw, data.history, assist, today) : []), [std, bw, data, assist, today]);
  const first = sessions.find((s) => s.date)?.date;
  const due = (horizon: string | null) => {
    const y = parseInt(horizon ?? '', 10);
    if (!first || !y) return null;
    const d = new Date(`${first}T12:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() + y);
    return d.toISOString().slice(0, 10);
  };
  return (
    <section class="card">
      <div class="lift-title">
        <h2>Fuckarounditis targets</h2>
        {editing ? (
          <span class="bw-edit">
            <Stepper value={draft} step={0.5} min={30} onChange={setDraft} />
            <button class="btn small primary" onClick={() => { onBodyweight(draft); setEditing(false); }}>Save</button>
          </span>
        ) : (
          <button class="btn small ghost" onClick={() => { setDraft(bw ?? 75); setEditing(true); }}>bodyweight {bw ?? '?'} kg ✎</button>
        )}
      </div>
      {!std && <p class="muted">No standards block (AW6:BE12) in {data.cycle.name}.</p>}
      {std && !bw && <p class="muted">Set your bodyweight to see where you are.</p>}
      {std && bw && (
        <>
          <p class="muted small-note">
            {std.levels.map((l) => {
              const d = due(l.horizon);
              return `${l.name}${l.horizon ? ` (${l.horizon}${d ? `, ${shortDate(d)}` : ''})` : ''}`;
            }).join(' · ')}
          </p>
          {rows.map((r) => {
            const next = r.missing.findIndex((m) => m > 0);
            const unit = r.isReps ? 'reps' : 'kg';
            return (
              <div class="target" key={r.name}>
                <div class="lift-title">
                  <b>{r.name}</b>
                  <span>{r.value == null ? <small class="muted">no data</small> : r.isReps ? <b>{r.value} reps</b> : <b>{r.value.toFixed(2)}×</b>}</span>
                </div>
                <LevelMeter value={r.value} targets={r.targets} labels={r.targets.map((t) => (r.isReps ? `${t}` : `${t}×`))} />
                <small class="muted">
                  {r.basis ?? ''}
                  {r.value != null && (next < 0
                    ? ' · all levels reached'
                    : ` · ${std.levels[next].name}: ${r.isReps ? r.missing[next] : kg1(r.missing[next])} ${unit} to go${r.eta[next] ? `, ~${months(r.eta[next]!)} at your 6-month pace` : ''}`)}
                </small>
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

function LiftProgress({ data, archive, sessions, today }: { data: Bootstrap; archive: Archive | null; sessions: PastSession[]; today: string }) {
  const [key, setKey] = useState<LiftKey>('squat');
  const list = useMemo(() => liftHistory(data.history, key), [data, key]);
  const prs = useMemo(() => {
    const out = new Set<string>();
    for (const s of sessions) for (const a of s.amraps) if (a.key === key && a.pr && s.date) out.add(s.date);
    return out;
  }, [sessions, key]);
  const points: Point[] = list.map((a) => ({ date: a.date, value: a.e1rm, pr: prs.has(a.date), label: `${kg(a.weight)} × ${a.reps}` }));
  const cycleStart = new Map<string, string>();
  for (const s of sessions) if (s.cycle && s.date && !cycleStart.has(s.cycle)) cycleStart.set(s.cycle, s.date);
  const steps: Point[] = data.history.trainingMaxes
    .filter((t) => t.tm[key] != null && cycleStart.has(t.cycle))
    .map((t) => ({ date: cycleStart.get(t.cycle)!, value: t.tm[key]! }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const best = bestE1rm(list);
  const cur = currentE1rm(list, today);
  const t90 = trend(list, 90, new Date(`${today}T12:00:00Z`));
  const grid = archive ? amrapGrid(archive.cycles, key) : [];
  const board = repPrBoard(list).slice(0, 12);
  const tm = data.cycle.tm[key];

  return (
    <section class="card">
      <div class="chips">
        {LIFTS.map((k) => <button key={k} class={`chip ${k === key ? 'on' : ''}`} onClick={() => setKey(k)}>{LIFT_LABEL[k]}</button>)}
      </div>
      <div class="facts">
        {best && <span>best e1RM <b>{kg1(best.e1rm)}</b> <small>({shortDate(best.date)})</small></span>}
        {cur && cur !== best && <span>recent best <b>{kg1(cur.e1rm)}</b></span>}
        {tm != null && cur && <span>TM <b>{kg(tm)}</b> = {Math.round((tm / cur.e1rm) * 100)}% of recent e1RM</span>}
        {t90 != null && <span class={t90 >= 0 ? 'up' : 'down'}>{t90 >= 0 ? '▲' : '▼'} {kg1(Math.abs(t90))} kg vs previous 90 days</span>}
        <span>{list.length} AMRAPs</span>
      </div>
      <ProgressChart points={points} steps={steps} />
      {stalled(grid) && <p class="down">Week-3 AMRAP reps dropped two cycles in a row: consider a 10% TM reset.</p>}

      {grid.length > 0 && (
        <>
          <h3>AMRAP reps by cycle</h3>
          <table class="rep-table">
            <thead><tr><th>cycle</th><th>wk1 5+</th><th>wk2 3+</th><th>wk3 1+</th></tr></thead>
            <tbody>
              {[...grid].reverse().map((r) => (
                <tr key={r.cycle}>
                  <td>{r.number}</td>
                  {r.weeks.map((w, i) => <td key={i}>{w ? <>{w.reps} <small class="muted">@{kg(w.weight)}</small></> : <span class="muted">–</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {board.length > 0 && (
        <>
          <h3>Rep PRs by weight</h3>
          <table class="rep-table">
            <thead><tr><th>weight</th><th>reps</th><th>e1RM</th><th>when</th></tr></thead>
            <tbody>
              {board.map((a) => (
                <tr key={a.weight} class={best && a.date === best.date && a.weight === best.weight ? 'pr' : ''}>
                  <td>{kg(a.weight)}</td><td>{a.reps}</td><td>{kg1(a.e1rm)}</td><td class="muted">{shortDate(a.date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
