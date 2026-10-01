import { useMemo, useState } from 'preact/hooks';
import type { Archive, Bootstrap, Config, Cycle, LiftKey } from './api.ts';
import { lastTrained, proposeTms, roundTm, type PastSession, type TmProposal } from './history.ts';
import { sendNow } from './queue.ts';
import { localDate, uuid } from './session.ts';
import { daysBetween, mround } from './stats.ts';
import { LIFT_LABEL, Stepper, kg, shortDate } from './ui.tsx';

const LIFTS: LiftKey[] = ['squat', 'bench', 'deadlift', 'press', 'wide_bench'];
const BREAK_DAYS = 14;

interface Props {
  cfg: Config;
  data: Bootstrap;
  archive: Archive | null;
  sessions: PastSession[];
  today: string;
  onCreated: () => void;
}

export function CycleView({ cfg, data, archive, sessions, today, onCreated }: Props) {
  const newest = archive?.cycles[0] && archive.cycles[0].number > data.cycle.number ? archive.cycles[0] : data.cycle;
  const newestStarted = sessions.some((s) => s.cycle === newest.name) || newest === data.cycle;
  return (
    <>
      <CurrentCycle cycle={data.cycle} sessions={sessions} />
      {newestStarted
        ? <NewCycle cfg={cfg} data={data} from={newest} sessions={sessions} today={today} onCreated={onCreated} />
        : <section class="card"><h2>{newest.name} is set up</h2><p class="muted">It becomes today's cycle once {data.cycle.name} is done.</p></section>}
      <TmHistory data={data} />
    </>
  );
}

function CurrentCycle({ cycle, sessions }: { cycle: Cycle; sessions: PastSession[] }) {
  const dates = new Map(sessions.filter((s) => s.cycle === cycle.name).map((s) => [`${s.week}-${s.day}`, s.date]));
  const done = cycle.weeks.flatMap((w) => w.days.filter((d) => d.lifts.some((l) => l.sets.some((s) => s.kind === 'amrap' && s.actual != null)))).length;
  const total = cycle.weeks.reduce((n, w) => n + w.days.length, 0);
  return (
    <section class="card">
      <div class="lift-title">
        <h2>{cycle.name}</h2>
        <span class="muted">{done}/{total} workouts</span>
      </div>
      <div class="facts">
        {LIFTS.filter((k) => cycle.tm[k] != null).map((k) => <span key={k}>{LIFT_LABEL[k]} <b>{kg(cycle.tm[k]!)}</b></span>)}
      </div>
      <table class="rep-table cycle-grid">
        <thead><tr><th /><th>D1</th><th>D2</th><th>D3</th><th>D4</th></tr></thead>
        <tbody>
          {cycle.weeks.map((w) => (
            <tr key={w.week}>
              <td class="muted">W{w.week}</td>
              {w.days.map((d) => {
                const amraps = d.lifts.flatMap((l) => l.sets.filter((s) => s.kind === 'amrap').map((s) => s.actual));
                const date = dates.get(`${w.week}-${d.day}`);
                return (
                  <td key={d.day} class={amraps.every((x) => x != null) ? 'up' : ''}>
                    {amraps.every((x) => x != null) ? '✓' : amraps.some((x) => x != null) ? '½' : '·'}
                    {date && <small class="muted"> {shortDate(date).slice(0, -3)}</small>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

type Choice = 'rule' | 'keep' | 'down5' | 'down10' | 'e1rm' | 'custom';

function optionsFor(p: TmProposal): { id: Choice; label: string; value: number }[] {
  const out: { id: Choice; label: string; value: number }[] = [];
  if (p.byRule != null) out.push({ id: 'rule', label: `rule +${p.steps}x`, value: p.byRule });
  out.push({ id: 'keep', label: 'keep', value: p.current });
  out.push({ id: 'down5', label: '−5%', value: roundTm(p.current * 0.95) });
  out.push({ id: 'down10', label: '−10%', value: roundTm(p.current * 0.9) });
  if (p.fromE1rm != null) out.push({ id: 'e1rm', label: '90% e1RM', value: p.fromE1rm });
  return out;
}

function NewCycle({ cfg, data, from, sessions, today, onCreated }: {
  cfg: Config; data: Bootstrap; from: Cycle; sessions: PastSession[]; today: string; onCreated: () => void;
}) {
  const proposals = useMemo(() => proposeTms(from, data.history, today), [from, data, today]);
  const trained = lastTrained(sessions);
  const gap = trained ? daysBetween(trained, today) : null;
  const onBreak = gap != null && gap > BREAK_DAYS;
  const initial = () => Object.fromEntries(proposals.map((p) => {
    const pick = !onBreak && p.byRule != null ? p.byRule : p.current;
    return [p.key, { choice: (!onBreak && p.byRule != null ? 'rule' : 'keep') as Choice, value: pick }];
  })) as Record<string, { choice: Choice; value: number }>;
  const [open, setOpen] = useState(false);
  const [tms, setTms] = useState(initial);
  const [bw, setBw] = useState(from.bodyweight ?? data.cycle.bodyweight ?? 75);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const w3Left = from.weeks.find((w) => w.week === 3)?.days.filter((d) => d.lifts.some((l) => l.sets.some((s) => s.kind === 'amrap' && s.actual == null))).length ?? 0;
  const name = `cycle${from.number + 1}`;

  const create = async () => {
    const tm = Object.fromEntries(Object.entries(tms).map(([k, v]) => [k, v.value]));
    const summary = proposals.map((p) => `${LIFT_LABEL[p.key]} ${kg(p.current)} → ${kg(tms[p.key].value)}`).join('\n');
    if (!confirm(`Create ${name} as a copy of ${from.name}?\n\n${summary}\nbodyweight ${bw} kg`)) return;
    setState({ busy: true, error: null, done: null });
    try {
      const [r] = await sendNow(cfg, [{
        id: uuid(), type: 'new_cycle', name, from: from.name, tm, bodyweight: bw, sessionDate: localDate(),
        note: proposals.map((p) => `${p.key} ${tms[p.key].value} (${tms[p.key].choice})`).join(', '),
      }]);
      if (r.status === 'error') throw new Error(r.error ?? 'failed');
      setState({ busy: false, error: null, done: `${name} created` });
      onCreated();
    } catch (e) {
      setState({ busy: false, error: (e as Error).message, done: null });
    }
  };

  if (state.done) return <section class="card"><h2>✓ {state.done}</h2><p class="muted">Reloading the sheet…</p></section>;
  if (!open) {
    return (
      <section class="card">
        <h2>Next: {name}</h2>
        <p class="muted">
          {w3Left ? `${w3Left} week-3 workout${w3Left > 1 ? 's' : ''} left in ${from.name}. ` : `${from.name} is done. `}
          {onBreak ? `Last workout ${gap} days ago: the setup suggests keeping or lowering TMs.` : ''}
        </p>
        <button class="btn primary wide" onClick={() => { setTms(initial()); setOpen(true); }}>Set up {name}</button>
      </section>
    );
  }
  return (
    <section class="card">
      <h2>Set up {name}</h2>
      {onBreak && (
        <p class="down">Last workout {shortDate(trained!)}: {gap} days ago. Coming back from a break, keep the TMs or take 5–10% off.</p>
      )}
      {w3Left > 0 && <p class="muted">{w3Left} week-3 workout{w3Left > 1 ? 's are' : ' is'} still open in {from.name}; the rule uses the AMRAPs logged so far.</p>}
      {proposals.map((p) => {
        const cur = tms[p.key];
        const opts = optionsFor(p);
        return (
          <div class="tm-row" key={p.key}>
            <div class="lift-title">
              <b>{LIFT_LABEL[p.key]}</b>
              <span class="muted">now {kg(p.current)}{p.week3.length ? ` · wk3 ${p.week3.map((a) => `${kg(a.weight)}×${a.reps}`).join(', ')}` : ' · no wk3 AMRAP'}</span>
            </div>
            <div class="chips">
              {opts.map((o) => (
                <button key={o.id} class={`chip ${cur.choice === o.id ? 'on' : ''}`} onClick={() => setTms({ ...tms, [p.key]: { choice: o.id, value: o.value } })}>
                  {o.label} <small>{kg(o.value)}</small>
                </button>
              ))}
            </div>
            <div class="tm-set">
              <Stepper value={cur.value} step={1.25} min={20} onChange={(v) => setTms({ ...tms, [p.key]: { choice: 'custom', value: v } })} />
              <small class={cur.value > p.current ? 'up' : cur.value < p.current ? 'down' : 'muted'}>
                {cur.value === p.current ? '±0' : `${cur.value > p.current ? '+' : ''}${kg(cur.value - p.current)}`}
                {' · '}wk1 {kg(mround(cur.value * 0.85))}×5+ · wk3 {kg(mround(cur.value * 0.95))}×1+
              </small>
            </div>
          </div>
        );
      })}
      <div class="tm-row">
        <div class="lift-title"><b>Bodyweight</b><Stepper value={bw} step={0.5} min={30} onChange={setBw} /></div>
      </div>
      <p class="muted small-note">
        Copies {from.name}: lift names, warm-ups, assistance exercises and all formulas stay. Logged sets, AMRAPs, notes and
        assistance weight/reps are cleared; plan assistance on the Today screen before each workout.
      </p>
      {state.error && <p class="down">Could not create it: {state.error}</p>}
      <div class="btn-row">
        <button class="btn primary" disabled={state.busy} onClick={() => void create()}>{state.busy ? 'Creating…' : `Create ${name}`}</button>
        <button class="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </section>
  );
}

function TmHistory({ data }: { data: Bootstrap }) {
  const rows = data.history.trainingMaxes;
  const keys = LIFTS.filter((k) => rows.some((r) => r.tm[k] != null));
  return (
    <section class="card">
      <h2>Training max history</h2>
      <table class="rep-table">
        <thead><tr><th>cycle</th>{keys.map((k) => <th key={k}>{LIFT_LABEL[k]}</th>)}<th>bw</th></tr></thead>
        <tbody>
          {rows.map((r, i) => {
            const older = rows[i + 1];
            return (
              <tr key={r.cycle}>
                <td>{r.number}</td>
                {keys.map((k) => {
                  const v = r.tm[k], p = older?.tm[k];
                  return <td key={k} class={v != null && p != null ? (v > p ? 'up' : v < p ? 'down' : '') : ''}>{v != null ? kg(v) : ''}</td>;
                })}
                <td class="muted">{r.bodyweight ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
