import { useState } from 'preact/hooks';
import type { Archive, Assistance, Day } from './api.ts';
import {
  normName, rangeFor, shortRounds, suggestAssist, weightStep, type AssistDone, type AssistSuggestion,
} from './history.ts';
import { daysBetween } from './stats.ts';
import { Stepper, kg, shortDate } from './ui.tsx';

type Values = { weight: number | null; reps: number | string | null };

const SHOW = 5;
const fmt = (v: Values) => (v.reps == null && v.weight == null ? 'not set' : `${v.weight ? `${kg(v.weight)} kg × ` : ''}${v.reps ?? '?'}`);
const same = (a: Values, b: Values) => (a.weight ?? null) === (b.weight ?? null) && String(a.reps ?? '') === String(b.reps ?? '');
const current = (a: Assistance): Values => ({ weight: typeof a.weight === 'number' ? a.weight : null, reps: a.reps });

/**
 * Before a workout: each assistance exercise with its recent history, target
 * range and a suggestion for today. Saving writes weight/reps to the cycle tab.
 */
export function AssistPlan({ day, archive, assist, trained, today, onSave }: {
  day: Day; archive: Archive | null; assist: Map<string, AssistDone[]>; trained: string | null; today: string;
  onSave: (a: Assistance, v: Values) => void;
}) {
  const plan = archive?.assistancePlan ?? [];
  const rows = day.assistance.map((a) => {
    const hist = assist.get(normName(a.name)) ?? [];
    const range = rangeFor(a.name, plan);
    return { a, hist, range, sug: suggestAssist(hist, range, today, trained) };
  });
  const pending = rows.filter((r) => r.sug.reps != null && !same(current(r.a), r.sug));

  return (
    <section class="card">
      <div class="lift-title">
        <h2>Assistance plan</h2>
        {pending.length > 1 && (
          <button class="btn small" onClick={() => pending.forEach((r) => onSave(r.a, { weight: r.sug.weight, reps: r.sug.reps }))}>Use all {pending.length}</button>
        )}
      </div>
      {!archive && <p class="muted small-note">Loading older cycles for the full history…</p>}
      {rows.map((r) => <Exercise key={r.a.index} {...r} today={today} onSave={(v) => onSave(r.a, v)} />)}
    </section>
  );
}

function Exercise({ a, hist, range, sug, today, onSave }: {
  a: Assistance; hist: AssistDone[]; range: string | null; sug: AssistSuggestion; today: string; onSave: (v: Values) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const now = current(a);
  const last = hist[hist.length - 1];
  const recent = [...hist].reverse().slice(0, showAll ? 20 : SHOW);
  return (
    <div class="assist-plan">
      <div class="lift-title">
        <b>{a.name}</b>
        <span class="muted">{range ? `range ${range} · ` : ''}{a.sets} rounds</span>
      </div>
      <div class="plan-now">
        <span>today: <b class={now.reps == null ? 'muted' : ''}>{fmt(now)}</b></span>
        {last?.date && <small class="muted">last done {daysBetween(last.date, today)} days ago</small>}
        <button class="btn small ghost" onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit'}</button>
      </div>
      {sug.reps != null && !same(now, sug) && (
        <div class={`suggest ${sug.kind}`}>
          <span>→ <b>{fmt(sug)}</b> <small>{sug.why}</small></span>
          <button class="btn small primary" onClick={() => onSave({ weight: sug.weight, reps: sug.reps })}>Use</button>
        </div>
      )}
      {sug.reps != null && same(now, sug) && <small class="up">✓ matches the suggestion: {sug.why}</small>}
      {editing && <Editor values={now.reps == null && now.weight == null ? { weight: sug.weight, reps: sug.reps } : now} step={weightStep(hist)} onSave={(v) => { onSave(v); setEditing(false); }} />}
      {recent.length > 0 && (
        <table class="rep-table assist-hist">
          <tbody>
            {recent.map((h, i) => {
              const short = shortRounds(h);
              return (
                <tr key={i}>
                  <td class="muted">{h.date ? shortDate(h.date) : '?'}</td>
                  <td>{fmt({ weight: h.weight, reps: h.reps })}</td>
                  <td>
                    {h.roundReps
                      ? h.roundReps.map((x, k) => <span key={k} class={short.includes(k + 1) ? 'down' : 'up'}>{x ?? '✓'} </span>)
                      : <span class={h.roundsDone >= h.sets ? 'up' : 'down'}>{h.roundsDone}/{h.sets}</span>}
                  </td>
                  <td class="muted note-cell">{[h.note, h.dayNote].filter(Boolean).join(' · ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {hist.length > SHOW && <button class="btn small ghost" onClick={() => setShowAll(!showAll)}>{showAll ? 'fewer' : `all ${hist.length}`}</button>}
    </div>
  );
}

function Editor({ values, step, onSave }: { values: Values; step: number; onSave: (v: Values) => void }) {
  const isText = typeof values.reps === 'string' && Number.isNaN(Number(values.reps));
  const [w, setW] = useState(values.weight ?? 0);
  const [r, setR] = useState(typeof values.reps === 'number' ? values.reps : parseInt(String(values.reps ?? ''), 10) || 0);
  const [text, setText] = useState(isText ? String(values.reps) : '');
  return (
    <div class="item-card current">
      <div class="change-form">
        <label>Weight <Stepper value={w} step={step} min={0} onChange={setW} /></label>
        <label>Reps <Stepper value={r} step={1} min={0} onChange={(v) => { setR(v); setText(''); }} /></label>
        <input type="text" placeholder="or free text, e.g. 35s" value={text} onInput={(e) => setText(e.currentTarget.value)} />
      </div>
      <div class="btn-row">
        <button class="btn primary" onClick={() => onSave({ weight: w || null, reps: text || r })}>Save</button>
      </div>
    </div>
  );
}
