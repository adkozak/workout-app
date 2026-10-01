// A small synthetic workbook in the real sheet's layout (see SHEET_STRUCTURE.md):
// cycle8 fully logged, cycle9 with week 1 logged, and an rm calc tab. Used by
// the tests and by the dev server when there is no snapshot of the real sheet.

const WEEK_ROWS = [4, 30, 56];
const DAY_COLS = [2, 13, 24, 35];
const TM_COL = { squat: 'C', bench: 'D', deadlift: 'E', press: 'F', wide_bench: 'G' };
const NAME = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', press: 'Press', wide_bench: 'Wide bench' };
const DAYS = [['squat', 'bench'], ['deadlift', 'press'], ['wide_bench', 'squat'], ['deadlift', 'press']];
const PCTS = [[0.65, 0.75, 0.85], [0.7, 0.8, 0.9], [0.75, 0.85, 0.95]];
const REPS = [['5', '5', '5+'], ['3', '3', '3+'], ['5', '3', '1+']];
const ASSISTANCE = [
  [['Dips', 10, 5, 8], ['Chin-ups', null, 5, 6], ['Ab wheel', null, 3, 10]],
  [['Pull-ups', null, 5, 6], ['Face pulls', 20, 3, 15], ['Hanging leg raise', null, 3, 10]],
  [['Dips', 10, 5, 8], ['Rows', 60, 5, 8], ['Plank', null, 3, '45s']],
  [['Chin-ups', null, 5, 6], ['Curls', 12, 3, 10], ['Back extension', null, 3, 12]],
];
// RM_LIFTS columns in rm calc (weight, reps).
const RM_COL = { squat: 3, deadlift: 6, bench: 9, wide_bench: 12, press: 15 };

const mround = (x) => Math.round(x / 2.5) * 2.5;

class Grid {
  constructor(name) { this.name = name; this.values = []; this.formulas = {}; this.notes = {}; }
  set(r, c, v, f) {
    (this.values[r - 1] ??= [])[c - 1] = v;
    if (f) this.formulas[`${r},${c}`] = f;
  }
  toJSON() { return { name: this.name, values: this.values.map((r) => r ?? []), formulas: this.formulas, notes: this.notes }; }
}

/** AMRAP reps logged for a lift in a given week: a little better each cycle. */
const amrapReps = (cycle, week, lift) => [9, 6, 4][week - 1] + (cycle - 8) + (lift === 'press' ? -1 : 0);

export function cycleTab(number, tm, loggedWeeks) {
  const g = new Grid(`cycle${number}`);
  g.set(1, 2, `cycle ${number}`);
  Object.entries(TM_COL).forEach(([key, col]) => g.set(1, col.charCodeAt(0) - 64, NAME[key]));
  g.set(2, 2, 'TM');
  Object.entries(TM_COL).forEach(([key, col]) => g.set(2, col.charCodeAt(0) - 64, tm[key]));
  g.set(6, 49, 'bw:');
  g.set(6, 50, 82);
  // Strength standards block (AW6:BE12), as in the real sheet.
  g.set(6, 54, '2y'); g.set(6, 56, '5y'); g.set(6, 57, '10y');
  g.set(7, 54, 'intermediate'); g.set(7, 56, 'advanced'); g.set(7, 57, 'elite');
  [['squat', 1.6, 2, 2.4], ['deadlift', 2, 2.5, 3], ['bench', 1.2, 1.5, 1.8], ['pullup', 1.2, 1.5, 1.8], ['pullup bw', 8, 15, 20]]
    .forEach(([name, a, b, e], i) => { g.set(8 + i, 49, name); g.set(8 + i, 54, a); g.set(8 + i, 56, b); g.set(8 + i, 57, e); });

  WEEK_ROWS.forEach((W, wi) => {
    const week = wi + 1;
    const logged = week <= loggedWeeks;
    g.set(W, 2, `Week ${week}`);
    DAY_COLS.forEach((c, di) => {
      g.set(W + 2, c, '%'); g.set(W + 2, c + 1, 'Weight'); g.set(W + 2, c + 2, '1 side');
      g.set(W + 2, c + 3, 'sets'); g.set(W + 2, c + 4, 'Reps'); g.set(W + 2, c + 5, 'actual');
      DAYS[di].forEach((key, li) => {
        const lift = li + 1;
        g.set(lift === 1 ? W + 1 : W + 10, c, NAME[key]);
        const r0 = lift === 1 ? W + 3 : W + 11;
        const t = tm[key], col = TM_COL[key];
        const warm = [0.4, 0.5, 0.6].map((p) => Math.max(20, mround(p * t)));
        for (let i = 0; i < 7; i++) {
          const r = r0 + i;
          let pct = '', weight, reps, sets = 1, formula;
          if (i < 3) { weight = warm[i]; reps = '5'; }
          else if (i < 6) {
            pct = PCTS[wi][i - 3];
            weight = mround(pct * t);
            reps = REPS[wi][i - 3];
            formula = `=MROUND(${c === 2 ? 'B' : 'X'}${r}*$${col}$2,2.5)`;
          } else {
            const done = logged ? amrapReps(number, week, key) : null;
            const suppPct = done == null || done < 10 ? PCTS[wi][0] : done < 15 ? PCTS[wi][1] : PCTS[wi][2];
            pct = suppPct;
            weight = mround(suppPct * t);
            reps = '5';
            sets = 5;
            formula = `=MROUND(IF(${'K'}${r - 1}<10,${PCTS[wi][0]},IF(K${r - 1}<15,${PCTS[wi][1]},${PCTS[wi][2]}))*$${col}$2,2.5)`;
          }
          g.set(r, c, pct);
          g.set(r, c + 1, weight, formula);
          g.set(r, c + 2, (weight - 20) / 2);
          g.set(r, c + 3, sets);
          g.set(r, c + 4, reps);
          if (i === 5) g.set(r, c + 5, logged ? amrapReps(number, week, key) : '');
          else if (i === 6) for (let k = 0; k < 5; k++) g.set(r, c + 5 + k, logged);
          else g.set(r, c + 5, logged);
        }
      });
      g.set(W + 18, c, 'Assistance');
      g.set(W + 19, c + 2, 'Weight'); g.set(W + 19, c + 3, 'sets'); g.set(W + 19, c + 4, 'reps');
      for (let k = 0; k < 5; k++) g.set(W + 19, c + 5 + k, logged);
      ASSISTANCE[di].forEach(([name, weight, sets, reps], a) => {
        const r = W + 20 + a;
        g.set(r, c, name);
        g.set(r, c + 2, weight ?? '');
        g.set(r, c + 3, sets);
        g.set(r, c + 4, reps);
      });
    });
  });
  return g;
}

function assistancePlan() {
  const g = new Grid('assistance plan');
  g.set(1, 1, 'current');
  g.set(3, 1, 'final:'); g.set(3, 2, 'range');
  [['Dips', '8-12'], ['Chin-ups', '4-6'], ['Face pulls', '12-15'], ['Rows', '8-12'], ['Plank', '45s']]
    .forEach(([name, range], i) => { g.set(4 + i, 1, name); g.set(4 + i, 2, range); });
  return g;
}

function rmCalc(sessions) {
  const g = new Grid('rm calc');
  g.set(1, 1, 'NEW SESSION');
  g.set(2, 1, 'CURRENT SESSION');
  g.set(2, 2, '#');
  Object.entries(RM_COL).forEach(([key, col]) => { g.set(2, col, NAME[key]); g.set(2, col + 1, 'reps'); g.set(2, col + 2, '1RM est'); });
  g.set(2, 18, 'date');
  sessions.forEach((s, i) => {
    const r = 3 + i;
    g.set(r, 2, i + 1);
    for (const [key, x] of Object.entries(s.lifts)) {
      g.set(r, RM_COL[key], x.weight);
      g.set(r, RM_COL[key] + 1, x.reps);
      g.set(r, RM_COL[key] + 2, x.weight * (1 + (x.reps - 1) / 40));
    }
    const [y, m, d] = s.date.split('-');
    g.set(r, 18, `${Number(d)}.${Number(m)}.${y}`);
  });
  return g;
}

/**
 * The fixture workbook. `today` anchors the dates: cycle9 week 1 was the last
 * four sessions, one every two days.
 */
export function fixture(today = new Date()) {
  const tm8 = { squat: 135, bench: 95, deadlift: 165, press: 57.5, wide_bench: 85 };
  const tm9 = { squat: 140, bench: 97.5, deadlift: 170, press: 60, wide_bench: 87.5 };
  const sessions = [];
  const logged = [[8, tm8, 3], [9, tm9, 1]];
  for (const [n, tm, weeks] of logged) {
    for (let week = 1; week <= weeks; week++) {
      DAYS.forEach((lifts) => {
        const s = { lifts: {} };
        for (const key of lifts) s.lifts[key] = { weight: mround(PCTS[week - 1][2] * tm[key]), reps: amrapReps(n, week, key) };
        sessions.push(s);
      });
    }
  }
  sessions.forEach((s, i) => {
    const d = new Date(today.getTime() - (sessions.length - i) * 2 * 86400e3);
    s.date = d.toISOString().slice(0, 10);
  });
  return {
    tz: 'Europe/Prague',
    sheets: [cycleTab(9, tm9, 1), cycleTab(8, tm8, 3), rmCalc(sessions), assistancePlan()].map((g) => g.toJSON()),
    props: {},
  };
}
