import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Assistance, Cycle, Day, History, LiftKey, SetRow } from './api.ts';
import {
  amrapGrid, assistanceLog, buildSessions, overview, parseRange, proposeTms, rangeFor, repPrBoard, stalled,
  standardsProgress, suggestAssist, type AssistDone, type PastSession,
} from './history.ts';
import { e1rm, type Amrap } from './stats.ts';

const KINDS: SetRow['kind'][] = ['warmup', 'warmup', 'warmup', 'main', 'main', 'amrap', 'supplemental'];

/** A lift with 7 sets at `w` kg; `amrap` reps logged (or null) and every other set ticked if logged. */
function lift(key: LiftKey, w: number, amrap: number | null): Day['lifts'][number] {
  const logged = amrap != null;
  return {
    name: key, key,
    sets: KINDS.map((kind, index) => ({
      index, kind, cell: '', pct: null, weight: w, sets: kind === 'supplemental' ? 5 : 1, reps: '5', note: null,
      ...(kind === 'amrap' ? { actual: amrap } : kind === 'supplemental' ? { done: Array(5).fill(logged) } : { done: logged }),
    })),
  };
}

function day(n: number, lifts: [LiftKey, number, number | null][], assistance: Assistance[] = [], rounds = 0): Day {
  return {
    day: n, lifts: lifts.map(([k, w, r]) => lift(k, w, r)), assistance,
    rounds: [0, 1, 2, 3, 4].map((i) => i < rounds), assistanceNote: null,
  };
}

function cycle(number: number, weeks: Day[][], tm: Partial<Record<LiftKey, number>> = {}): Cycle {
  return {
    name: `cycle${number}`, number, tm, writable: true, layoutProblems: [], bodyweight: 80,
    weeks: weeks.map((days, i) => ({ week: i + 1, days })),
  };
}

const rmRow = (row: number, date: string, lifts: History['sessions'][number]['lifts']) => ({ row, date, lifts });

test('sessions: tab days get dates from rm calc in order; leftovers become AMRAP-only sessions; PRs flagged', () => {
  const c8 = cycle(8, [[
    day(1, [['squat', 100, 8], ['bench', 70, 9]]),
    day(2, [['deadlift', 120, 7], ['press', 45, 6]]),
    day(3, [['wide_bench', 60, null], ['squat', 100, null]]), // not done
  ]]);
  const history: History = {
    sessions: [
      rmRow(3, '2025-01-05', { squat: { weight: 90, reps: 10 } }), // cycle7, no tab
      rmRow(4, '2025-03-01', { squat: { weight: 100, reps: 8 }, bench: { weight: 70, reps: 9 } }),
      rmRow(5, '2025-03-04', { deadlift: { weight: 120, reps: 7 }, press: { weight: 45, reps: 6 } }),
    ],
    trainingMaxes: [], log: [],
  };
  const s = buildSessions(history, [c8]);
  assert.deepEqual(s.map((x) => `${x.id}@${x.date}`), ['rm:3@2025-01-05', 'cycle8/w1d1@2025-03-01', 'cycle8/w1d2@2025-03-04']);
  assert.equal(s[1].amraps.find((a) => a.key === 'squat')!.pr, e1rm(100, 8) > e1rm(90, 10));
  // 3 warm-ups and 2 mains of 5, the AMRAP, and 5x5: (25 + reps + 25) x weight per lift
  assert.equal(s[1].tonnage, (25 + 8 + 25) * 100 + (25 + 9 + 25) * 70);
});

test('sessions: the app log dates a day and supplies its summary; rm weight wins over the tab', () => {
  const c9 = cycle(9, [[day(1, [['squat', 100, 8], ['bench', 70, 9]])]]);
  const history: History = {
    sessions: [rmRow(10, '2025-05-01', { squat: { weight: 102.5, reps: 8 }, wide_bench: { weight: 70, reps: 9 } })],
    trainingMaxes: [],
    log: [
      { cycle: 'cycle9', week: 1, day: 1, 'session date': '2025-05-02T00:00:00', kind: 'set' },
      { cycle: 'cycle9', week: 1, day: 1, 'session date': '2025-05-02T00:00:00', kind: 'workout summary', 'secs since start': 3600, 'actual weight': 9000, 'actual reps': 8 },
    ],
  };
  const [s] = buildSessions(history, [c9]);
  assert.equal(s.date, '2025-05-02');
  assert.equal(s.dateFrom, 'log');
  assert.deepEqual(s.summary, { secs: 3600, tonnage: 9000, rpe: 8, hrAvg: null, hrMax: null });
  assert.deepEqual(s.amraps.map((a) => `${a.key} ${a.weight}`), ['squat 102.5', 'wide_bench 70']);
});

const ex = (name: string, weight: number | null, reps: number | string | null, roundReps: Assistance['roundReps'] = null): Assistance =>
  ({ index: 0, name, weight, sets: 5, reps, roundReps, note: null });

function assistHistory(entries: [string, number | null, number | string, number, Assistance['roundReps']?][]): AssistDone[] {
  const c = cycle(8, [entries.map(([, w, r, rounds, rr], i) => day(i + 1, [['squat', 100, 5]], [ex('Dips', w, r, rr)], rounds))]);
  const history: History = {
    sessions: entries.map(([date], i) => rmRow(i + 3, date, { squat: { weight: 100, reps: 5 } })),
    trainingMaxes: [], log: [],
  };
  return assistanceLog(buildSessions(history, [c])).get('dips')!;
}

test('assistance suggestion: +1 rep, more weight at the top of the range, repeat after misses, ease back after a break', () => {
  const upRep = suggestAssist(assistHistory([['2026-09-01', 5, 9, 5]]), '8-12', '2026-09-04', '2026-09-01');
  assert.deepEqual([upRep.weight, upRep.reps, upRep.kind], [5, 10, 'up']);

  const top = assistHistory([['2026-08-20', 2.5, 12, 5], ['2026-09-01', 5, 12, 5]]);
  const heavier = suggestAssist(top, '8-12', '2026-09-04', '2026-09-01');
  assert.deepEqual([heavier.weight, heavier.reps], [7.5, 8]);

  const missed = suggestAssist(assistHistory([['2026-09-01', 5, 10, 5, [null, null, null, 8, 7]]]), '8-12', '2026-09-04', '2026-09-01');
  assert.deepEqual([missed.weight, missed.reps, missed.kind], [5, 10, 'repeat']);
  assert.match(missed.why, /rounds 4, 5/);

  const partial = suggestAssist(assistHistory([['2026-09-01', 5, 10, 3]]), '8-12', '2026-09-04', '2026-09-01');
  assert.equal(partial.kind, 'repeat');

  const back = suggestAssist(assistHistory([['2026-06-01', 5, 10, 5]]), '8-12', '2026-09-04', '2026-06-01');
  assert.deepEqual([back.reps, back.kind], [8, 'down']);

  const timed = suggestAssist(assistHistory([['2026-09-01', 16, '30s', 5]]), '30s per side', '2026-09-04', '2026-09-01');
  assert.equal(timed.reps, '35s');

  assert.equal(suggestAssist([], '8-12', '2026-09-04', null).reps, 8);
});

test('assistance ranges: exact name, else contained words', () => {
  const plan = [{ name: 'db row', range: '8-12' }, { name: 'reverse flys', range: '12-15' }, { name: 'split squat', range: '8-12' }];
  assert.equal(rangeFor('db row fat', plan), '8-12');
  assert.equal(rangeFor('inclined reverse fly', plan), '12-15');
  assert.equal(rangeFor('Bulgarian split squat', plan), '8-12');
  assert.equal(rangeFor('plank', plan), null);
  assert.deepEqual(parseRange('8+'), { lo: 8, hi: null, unit: '' });
  assert.deepEqual(parseRange('10'), { lo: 10, hi: 10, unit: '' });
  assert.deepEqual(parseRange('30s per side'), { lo: 30, hi: null, unit: 's' });
});

test('next-cycle TMs: rule from the last week-3 AMRAP, and 90% of recent e1RM', () => {
  const c = cycle(15, [[], [], [day(1, [['squat', 95, 8], ['bench', 62.5, 11]]), day(3, [['wide_bench', 55, null], ['squat', 95, 12]])]],
    { squat: 100, bench: 66.25, wide_bench: 60 });
  const history: History = { sessions: [rmRow(3, '2026-09-20', { squat: { weight: 95, reps: 12 } })], trainingMaxes: [], log: [] };
  const p = Object.fromEntries(proposeTms(c, history, '2026-09-30').map((x) => [x.key, x]));
  assert.equal(p.squat.byRule, 105); // 12 reps: +2x, x = 2.5
  assert.equal(p.bench.byRule, 68.75); // 11 reps: +2x, x = 1.25
  assert.equal(p.wide_bench.byRule, null);
  assert.equal(p.squat.fromE1rm, Math.round((e1rm(95, 12) * 0.9) / 1.25) * 1.25);
  assert.equal(p.bench.fromE1rm, null);
});

test('standards: ratio to bodyweight, kg missing, chin-ups from assistance', () => {
  const history: History = {
    sessions: [rmRow(3, '2026-09-01', { squat: { weight: 100, reps: 10 } })], trainingMaxes: [], log: [],
  };
  const std = { levels: [{ name: 'intermediate', horizon: '2y' }], rows: [{ name: 'squat', targets: [1.6] }, { name: 'pullup bw', targets: [8] }, { name: 'bench', targets: [1.2] }] };
  const chins = new Map([['pullup', assistHistory([['2026-09-01', null, 9, 5]])]]);
  const [sq, pull, bench] = standardsProgress(std, 80, history, chins, '2026-09-30');
  assert.ok(Math.abs(sq.value! - e1rm(100, 10) / 80) < 1e-9);
  assert.ok(Math.abs(sq.missing[0] - (1.6 * 80 - e1rm(100, 10))) < 1e-9);
  assert.deepEqual([pull.value, pull.missing[0], pull.isReps], [9, -1, true]);
  assert.equal(bench.value, null);
});

test('overview: streaks, breaks, months', () => {
  const mk = (date: string): PastSession => ({
    id: date, date, dateFrom: 'rm', cycle: null, cycleNumber: null, week: null, day: null, detail: null,
    amraps: [], log: [], summary: null, tonnage: 1000,
  });
  const o = overview(['2026-08-03', '2026-08-05', '2026-08-12', '2026-09-14', '2026-09-22', '2026-09-29'].map(mk), '2026-09-30', 3);
  assert.equal(o.sessions, 6);
  assert.deepEqual(o.perMonth, [{ month: '2026-07', n: 0 }, { month: '2026-08', n: 3 }, { month: '2026-09', n: 3 }]);
  assert.equal(o.currentStreakWeeks, 3);
  assert.equal(o.longestStreakWeeks, 3);
  assert.deepEqual(o.breaks, [{ from: '2026-08-12', to: '2026-09-14', days: 33 }]);
  assert.equal(o.tonnage, 6000);
});

test('AMRAP grid, stall and rep PR board', () => {
  const cs = [8, 9, 10].map((n, i) => cycle(n, [[day(1, [['squat', 100, 10 - i]])], [], [day(1, [['squat', 110, 6 - i]])]]));
  const g = amrapGrid(cs, 'squat');
  assert.deepEqual(g.map((r) => r.weeks.map((w) => w?.reps ?? null)), [[10, null, 6], [9, null, 5], [8, null, 4]]);
  assert.equal(stalled(g), true);
  const a = (weight: number, reps: number, date = '2026-01-01'): Amrap => ({ date, weight, reps, e1rm: e1rm(weight, reps) });
  assert.deepEqual(repPrBoard([a(100, 5), a(100, 7), a(90, 10)]).map((x) => `${x.weight}x${x.reps}`), ['100x7', '90x10']);
});
