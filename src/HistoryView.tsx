import { useMemo, useState } from 'preact/hooks';
import type { LiftKey, SetRow } from './api.ts';
import type { LogRow, PastSession } from './history.ts';
import { LIFT_LABEL, kg, kg1, shortDate } from './ui.tsx';

const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const mins = (secs: number) => `${Math.round(secs / 60)} min`;
const tons = (kgs: number) => (kgs >= 1000 ? `${(kgs / 1000).toFixed(1)} t` : `${Math.round(kgs)} kg`);
const LIFTS: LiftKey[] = ['squat', 'bench', 'deadlift', 'press', 'wide_bench'];

export function sessionTitle(s: PastSession): string {
  return s.week ? `W${s.week} D${s.day}` : 'AMRAP only';
}

export function HistoryList({ sessions, go }: { sessions: PastSession[]; go: (hash: string) => void }) {
  const [lift, setLift] = useState<LiftKey | null>(null);
  const shown = useMemo(() => [...sessions].reverse().filter((s) => !lift || s.amraps.some((a) => a.key === lift)), [sessions, lift]);
  const groups: { title: string; items: PastSession[] }[] = [];
  const firstTab = sessions.find((s) => s.cycle)?.date ?? '';
  for (const s of shown) {
    const title = s.cycle ?? (s.date && s.date < firstTab ? 'Before cycle 8 (from rm calc)' : 'Only in rm calc');
    if (groups[groups.length - 1]?.title !== title) groups.push({ title, items: [] });
    groups[groups.length - 1].items.push(s);
  }
  return (
    <>
      <div class="chips">
        <button class={`chip ${lift ? '' : 'on'}`} onClick={() => setLift(null)}>All</button>
        {LIFTS.map((k) => <button key={k} class={`chip ${lift === k ? 'on' : ''}`} onClick={() => setLift(k)}>{LIFT_LABEL[k]}</button>)}
      </div>
      {groups.map((g, gi) => (
        <section class="card" key={gi}>
          <h2>{g.title}</h2>
          {g.items.map((s) => (
            <button class="hist-row" key={s.id} onClick={() => go(`history/${s.id}`)}>
              <span class="hist-date">
                {s.date ? <><b>{shortDate(s.date)}</b><small>{weekday(s.date)}</small></> : <small>no date</small>}
              </span>
              <span class="hist-what">
                <small class="muted">{sessionTitle(s)}</small>
                {s.amraps.map((a) => (
                  <span key={a.key}>{LIFT_LABEL[a.key]} {kg(a.weight)}×{a.reps}{a.pr && <b class="pr-star"> ★</b>}</span>
                ))}
                {!s.amraps.length && <span class="muted">no AMRAP logged</span>}
              </span>
              <span class="hist-side">
                {(s.summary?.tonnage ?? s.tonnage) ? <small>{tons(s.summary?.tonnage ?? s.tonnage!)}</small> : null}
                {s.summary?.secs ? <small>{mins(s.summary.secs)}</small> : null}
              </span>
            </button>
          ))}
        </section>
      ))}
    </>
  );
}

/** Where this AMRAP's e1RM ranked among all earlier ones on the lift. */
function rankAtTime(sessions: PastSession[], s: PastSession, key: LiftKey, value: number): { rank: number; of: number } {
  const i = sessions.indexOf(s);
  const earlier = sessions.slice(0, i).flatMap((x) => x.amraps.filter((a) => a.key === key).map((a) => a.e1rm));
  return { rank: earlier.filter((v) => v > value).length + 1, of: earlier.length + 1 };
}

const KIND_LABEL: Record<SetRow['kind'], string> = { warmup: 'warm-up', main: 'main', amrap: 'AMRAP', supplemental: '5×5' };

function setStatus(s: SetRow): { text: string; cls: string } {
  if (s.kind === 'amrap') return s.actual != null ? { text: `${s.actual} reps`, cls: 'up' } : { text: '–', cls: 'muted' };
  if (Array.isArray(s.done)) {
    const n = s.done.filter(Boolean).length;
    return { text: `${n}/${s.done.length}`, cls: n === s.done.length ? 'up' : n ? '' : 'muted' };
  }
  return s.done ? { text: '✓', cls: 'up' } : { text: '–', cls: 'muted' };
}

const clockOf = (x: unknown) => (/T(\d{2}:\d{2})/.exec(String(x ?? ''))?.[1] ?? '');

export function SessionDetail({ sessions, id, go }: { sessions: PastSession[]; id: string; go: (hash: string) => void }) {
  const i = sessions.findIndex((s) => s.id === id);
  const s = sessions[i];
  if (!s) return <p class="muted">That session isn't in the loaded history.</p>;
  const prev = sessions[i - 1], next = sessions[i + 1];
  const d = s.detail;
  const timeline = s.log
    .filter((r) => r['done at'] && r.kind !== 'workout summary')
    .sort((a, b) => String(a['done at']).localeCompare(String(b['done at'])));

  return (
    <>
      <header>
        <div>
          <h1>{s.date ? `${weekday(s.date)} ${shortDate(s.date)}` : 'Date unknown'}</h1>
          <small>{s.cycle ? `${s.cycle} · ${sessionTitle(s)}` : 'rm calc row, before the app-readable tabs'}{s.dateFrom === 'rm' && s.cycle ? ' · dated from rm calc' : ''}</small>
        </div>
        <div class="btn-row tight">
          <button class="btn small" disabled={!prev} onClick={() => prev && go(`history/${prev.id}`)}>‹</button>
          <button class="btn small" disabled={!next} onClick={() => next && go(`history/${next.id}`)}>›</button>
        </div>
      </header>

      <section class="card">
        <div class="facts">
          {(s.summary?.tonnage ?? s.tonnage) ? <span><b>{tons(s.summary?.tonnage ?? s.tonnage!)}</b> moved</span> : null}
          {s.summary?.secs ? <span><b>{mins(s.summary.secs)}</b></span> : null}
          {s.summary?.rpe ? <span>RPE <b>{s.summary.rpe}</b></span> : null}
          {s.summary?.hrAvg ? <span>HR avg <b>{s.summary.hrAvg}</b>{s.summary.hrMax ? ` · max ${s.summary.hrMax}` : ''}</span> : null}
        </div>
        {s.amraps.map((a) => {
          const r = rankAtTime(sessions, s, a.key, a.e1rm);
          return (
            <div class="row" key={a.key}>
              <span>{LIFT_LABEL[a.key]} <b>{kg(a.weight)} × {a.reps}</b>{a.pr && <b class="pr-star"> ★ PR</b>}</span>
              <span class="muted">e1RM {kg1(a.e1rm)} · #{r.rank} of {r.of}</span>
            </div>
          );
        })}
      </section>

      {d?.lifts.map((l) => (
        <section class="card" key={l.name}>
          <h2>{l.key ? LIFT_LABEL[l.key] : l.name}</h2>
          <table class="rep-table">
            <tbody>
              {l.sets.map((x) => {
                const st = setStatus(x);
                return (
                  <tr key={x.index} class={x.kind === 'amrap' ? 'pr' : ''}>
                    <td class="muted">{KIND_LABEL[x.kind]}</td>
                    <td>{kg(x.weight)} × {x.kind === 'supplemental' ? `${x.sets}×${x.reps}` : x.reps}</td>
                    <td class={st.cls}>{st.text}</td>
                    <td class="muted note-cell">{x.note?.replace(/^app: /, '') ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}

      {d && d.assistance.length > 0 && (
        <section class="card">
          <h2>Assistance <small class="muted">{d.rounds.filter(Boolean).length}/{d.rounds.length} rounds{d.assistanceNote ? ` · ${d.assistanceNote}` : ''}</small></h2>
          {d.assistance.map((a) => (
            <div class="row" key={a.index}>
              <span>{a.name}{a.note && <small class="muted"> · {a.note}</small>}</span>
              <span>
                {a.weight != null && a.weight !== '' ? `${a.weight} kg × ` : ''}{a.sets}×{a.reps ?? '?'}
                {a.roundReps && <small class="down"> · rounds {a.roundReps.map((x) => x ?? '✓').join(' ')}</small>}
              </span>
            </div>
          ))}
        </section>
      )}

      {timeline.length > 0 && <Timeline rows={timeline} />}
    </>
  );
}

function Timeline({ rows }: { rows: LogRow[] }) {
  return (
    <section class="card">
      <h2>Logged by the app</h2>
      <table class="rep-table">
        <thead><tr><th>time</th><th>what</th><th>did</th><th>gap</th><th>HR</th></tr></thead>
        <tbody>
          {rows.map((r, k) => {
            const w = r['actual weight'], reps = r['actual reps'];
            const did = r.status === 'skipped' ? 'skipped' : r.status === 'undo' ? 'undone' : [w !== '' && w != null ? `${w}` : '', reps !== '' && reps != null ? `×${reps}` : ''].join('') || String(r.status ?? '');
            const gap = Number(r['secs since previous']);
            return (
              <tr key={k} class={r.status === 'changed' || r.status === 'skipped' ? 'dev' : ''}>
                <td class="muted">{clockOf(r['done at'])}</td>
                <td>{String(LIFT_LABEL[String(r.exercise)] ?? r.exercise ?? '')} <small class="muted">{String(r.kind ?? '')} {String(r.set ?? '')}</small></td>
                <td>{did}</td>
                <td class="muted">{Number.isFinite(gap) && gap > 0 ? `${Math.floor(gap / 60)}:${String(gap % 60).padStart(2, '0')}` : ''}</td>
                <td class="muted">{String(r['hr done'] ?? '')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
