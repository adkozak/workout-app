// Everything the History, Progress and Cycle screens compute from the sheet:
// past sessions with dates, assistance history and next-time suggestions,
// strength standards, overview stats and next-cycle TM proposals. Pure functions
// over the archive (cycle tabs) and history (rm calc, TM rows, session log).

import type { Cycle, Day, History, LiftKey, SetRow, Standards } from './api.ts';
import { bestE1rm, daysBetween, e1rm, liftHistory, tmIncrement, tmSteps, type Amrap } from './stats.ts';

export type LogRow = Record<string, unknown>;

export interface AmrapResult { key: LiftKey; weight: number; reps: number; e1rm: number; pr: boolean }

export interface PastSession {
  /** `cycle15/w2d3` for a cycle-tab day, `rm:<row>` for an rm calc row with no tab behind it (cycle1-7). */
  id: string;
  date: string | null;
  /** Where the date came from: the app's session log, or the matching rm calc row. */
  dateFrom: 'log' | 'rm' | null;
  cycle: string | null;
  cycleNumber: number | null;
  week: number | null;
  day: number | null;
  /** The day as the cycle tab has it (cycle8+ only). */
  detail: Day | null;
  amraps: AmrapResult[];
  log: LogRow[];
  /** From the app's workout summary row. */
  summary: { secs: number | null; tonnage: number | null; rpe: number | null; hrAvg: number | null; hrMax: number | null } | null;
  /** kg moved on the barbell, from the ticked sets in the tab. */
  tonnage: number | null;
}

const LIFT_ORDER: LiftKey[] = ['squat', 'bench', 'deadlift', 'press', 'wide_bench'];

const str = (x: unknown) => (x == null ? '' : String(x));
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
export const isoDay = (x: unknown): string | null => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(x));
  return m ? m[1] : null;
};

export function dayKey(cycle: string, week: number, day: number): string {
  return `${cycle}/w${week}d${day}`;
}

function logKey(r: LogRow): string | null {
  const c = str(r.cycle), w = num(r.week), d = num(r.day);
  return c && w && d ? dayKey(c, w, d) : null;
}

function sheetAmraps(day: Day): { key: LiftKey; weight: number; reps: number }[] {
  const out: { key: LiftKey; weight: number; reps: number }[] = [];
  for (const l of day.lifts) {
    const s = l.sets.find((x) => x.kind === 'amrap');
    if (l.key && s && typeof s.actual === 'number') out.push({ key: l.key, weight: s.weight, reps: s.actual });
  }
  return out;
}

function anyLogged(day: Day): boolean {
  return day.rounds.some(Boolean) || day.lifts.some((l) => l.sets.some((s) =>
    s.actual != null || s.done === true || (Array.isArray(s.done) && s.done.some(Boolean))));
}

const reps = (s: SetRow) => parseInt(s.reps, 10) || 0;

/** kg on the bar times reps, for every set ticked in the tab. */
export function dayTonnage(day: Day): number {
  let t = 0;
  for (const l of day.lifts) {
    for (const s of l.sets) {
      if (typeof s.weight !== 'number') continue;
      if (s.kind === 'amrap') t += s.actual != null ? s.weight * s.actual : 0;
      else if (Array.isArray(s.done)) t += s.done.filter(Boolean).length * s.weight * reps(s);
      else if (s.done) t += s.weight * reps(s);
    }
  }
  return t;
}

type RmRow = History['sessions'][number];

/** rm calc lifts equal to the day's AMRAPs (same reps, weight within 5 kg; bench and wide bench interchangeable). */
function rmMatches(row: RmRow, amraps: { key: LiftKey; weight: number; reps: number }[]): Partial<Record<LiftKey, LiftKey>> | null {
  if (!amraps.length) return null;
  const used = new Set<LiftKey>();
  const map: Partial<Record<LiftKey, LiftKey>> = {};
  for (const a of amraps) {
    const family: LiftKey[] = a.key === 'bench' || a.key === 'wide_bench' ? [a.key, a.key === 'bench' ? 'wide_bench' : 'bench'] : [a.key];
    const hit = family.find((k) => {
      const x = row.lifts[k];
      return x && !used.has(k) && x.reps === a.reps && Math.abs(x.weight - a.weight) <= 5;
    });
    if (!hit) return null;
    used.add(hit);
    map[a.key] = hit;
  }
  return map;
}

const MATCH_WINDOW = 12;

/**
 * Every session there is a record of, oldest first. Cycle-tab days (cycle8+) are
 * matched to rm calc rows in order to get their dates; the app's session log dates
 * the days it logged. rm calc rows left over (cycle1-7, or days missing from a tab)
 * become AMRAP-only sessions.
 */
export function buildSessions(history: History, cycles: Cycle[]): PastSession[] {
  const rm = [...history.sessions].sort((a, b) => a.row - b.row);
  const logs = new Map<string, LogRow[]>();
  for (const r of history.log) {
    const k = logKey(r);
    if (k) logs.set(k, [...(logs.get(k) ?? []), r]);
  }
  const usedRm = new Set<number>();
  const out: PastSession[] = [];
  let pointer = 0;
  let matchedOnce = false;

  for (const c of [...cycles].sort((a, b) => a.number - b.number)) {
    for (const w of c.weeks) {
      for (const d of w.days) {
        const id = dayKey(c.name, w.week, d.day);
        const log = logs.get(id) ?? [];
        if (!anyLogged(d) && !log.length) continue;
        const amraps = sheetAmraps(d);
        let date: string | null = null;
        let dateFrom: PastSession['dateFrom'] = null;
        let keys: Partial<Record<LiftKey, LiftKey>> = {};
        let weights: Partial<Record<LiftKey, number>> = {};
        const end = matchedOnce ? Math.min(rm.length, pointer + MATCH_WINDOW) : rm.length;
        for (let i = pointer; i < end; i++) {
          const m = rmMatches(rm[i], amraps);
          if (!m) continue;
          keys = m;
          weights = Object.fromEntries(Object.entries(m).map(([k, rk]) => [k, rm[i].lifts[rk as LiftKey]!.weight]));
          date = rm[i].date;
          dateFrom = 'rm';
          usedRm.add(rm[i].row);
          pointer = i + 1;
          matchedOnce = true;
          break;
        }
        const logDate = log.map((r) => isoDay(r['session date'])).filter(Boolean).sort().pop() ?? null;
        if (logDate) { date = logDate; dateFrom = 'log'; }
        const summaryRow = [...log].reverse().find((r) => r.kind === 'workout summary');
        out.push({
          id, date, dateFrom, cycle: c.name, cycleNumber: c.number, week: w.week, day: d.day, detail: d,
          amraps: amraps.map((a) => {
            const key = keys[a.key] ?? a.key;
            const weight = weights[a.key] ?? a.weight;
            return { key, weight, reps: a.reps, e1rm: e1rm(weight, a.reps), pr: false };
          }),
          log,
          summary: summaryRow ? {
            secs: num(summaryRow['secs since start']), tonnage: num(summaryRow['actual weight']),
            rpe: num(summaryRow['actual reps']), hrAvg: num(summaryRow['hr avg']), hrMax: num(summaryRow['hr peak']),
          } : null,
          tonnage: dayTonnage(d) || null,
        });
      }
    }
  }

  for (const r of rm) {
    if (usedRm.has(r.row)) continue;
    const amraps = LIFT_ORDER.filter((k) => r.lifts[k]).map((k) => {
      const { weight, reps: n } = r.lifts[k]!;
      return { key: k, weight, reps: n, e1rm: e1rm(weight, n), pr: false };
    });
    out.push({
      id: `rm:${r.row}`, date: r.date, dateFrom: 'rm', cycle: null, cycleNumber: null, week: null, day: null,
      detail: null, amraps, log: [], summary: null, tonnage: null,
    });
  }

  // Undated tab days sort right after the session before them in the tab.
  const sortKey = new Map<PastSession, string>();
  let last = '';
  for (const s of out) {
    if (s.date) last = s.date;
    sortKey.set(s, s.date ?? last);
  }
  out.sort((a, b) => sortKey.get(a)!.localeCompare(sortKey.get(b)!) || (a.cycleNumber ?? 0) - (b.cycleNumber ?? 0));

  const best: Partial<Record<LiftKey, number>> = {};
  for (const s of out) {
    for (const a of s.amraps) {
      const b = best[a.key];
      a.pr = b != null && a.e1rm > b + 1e-9;
      if (b == null || a.e1rm > b) best[a.key] = a.e1rm;
    }
  }
  return out;
}

export function lastTrained(sessions: PastSession[]): string | null {
  return sessions.map((s) => s.date).filter((d): d is string => !!d).sort().pop() ?? null;
}

// ---------- assistance ----------

export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stem = (w: string) => w.replace(/s$/, '');

export interface AssistDone {
  session: PastSession;
  date: string | null;
  index: number;
  name: string;
  weight: number | null;
  sets: number;
  reps: number | string | null;
  roundsDone: number;
  roundsPlanned: number;
  /** Reps per round when known (typed in the sheet or logged by the app); null = as planned or unknown. */
  roundReps: (number | string | null)[] | null;
  note: string | null;
  dayNote: string | null;
}

/** Per-round reps the app logged ("#2: 4, #3: 5" on assistance round rows), by exercise index. */
function loggedRoundReps(log: LogRow[]): Map<number, (number | null)[]> {
  const out = new Map<number, (number | null)[]>();
  for (const r of log) {
    if (r.slot !== 'assist_round' && r.kind !== 'assist_round') continue;
    const round = num(r.set);
    if (round == null) continue;
    for (const [, ex, n] of str(r.note).matchAll(/#(\d+):\s*(\d+)/g)) {
      const list = out.get(Number(ex) - 1) ?? [null, null, null, null, null];
      list[round] = r.status === 'undo' ? null : Number(n);
      out.set(Number(ex) - 1, list);
    }
  }
  return out;
}

/** Every time each assistance exercise was done, oldest first, keyed by normalised name. */
export function assistanceLog(sessions: PastSession[]): Map<string, AssistDone[]> {
  const out = new Map<string, AssistDone[]>();
  for (const s of sessions) {
    if (!s.detail) continue;
    const logged = loggedRoundReps(s.log);
    for (const a of s.detail.assistance) {
      if (a.weight == null && a.reps == null) continue;
      const fromLog = logged.get(a.index);
      const entry: AssistDone = {
        session: s, date: s.date, index: a.index, name: a.name,
        weight: typeof a.weight === 'number' ? a.weight : null,
        sets: a.sets || 5, reps: a.reps,
        roundsDone: s.detail.rounds.filter(Boolean).length, roundsPlanned: s.detail.rounds.length,
        roundReps: a.roundReps ?? (fromLog?.some((x) => x != null) ? fromLog : null),
        note: a.note ?? null, dayNote: s.detail.assistanceNote,
      };
      const k = normName(a.name);
      out.set(k, [...(out.get(k) ?? []), entry]);
    }
  }
  return out;
}

/** The "assistance plan" range for an exercise: exact name, else one name's words inside the other's. */
export function rangeFor(name: string, plan: { name: string; range: string }[]): string | null {
  const words = (s: string) => normName(s).split(' ').map(stem);
  const n = words(name);
  const exact = plan.find((p) => normName(p.name) === normName(name));
  if (exact) return exact.range;
  const within = (a: string[], b: string[]) => a.every((w) => b.includes(w));
  const hit = plan.find((p) => within(words(p.name), n)) ?? plan.find((p) => within(n, words(p.name)));
  return hit?.range ?? null;
}

export interface Range { lo: number; hi: number | null; unit: string }

export function parseRange(r: string | null): Range | null {
  const m = /^\s*(\d+)\s*(?:(-)\s*(\d+)|(\+))?\s*([a-z]*)/i.exec(r ?? '');
  if (!m) return null;
  const lo = Number(m[1]);
  return { lo, hi: m[3] ? Number(m[3]) : m[4] ? null : m[5] ? null : lo, unit: m[5] ?? '' };
}

/** "12" -> 12, "30s" -> {30, 's'} */
function parseReps(x: number | string | null): { n: number; unit: string } | null {
  if (typeof x === 'number') return { n: x, unit: '' };
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)/i.exec(x ?? '');
  return m ? { n: Number(m[1]), unit: m[2] } : null;
}

const fmtReps = (n: number, unit: string) => (unit ? `${n}${unit}` : n);

export interface AssistSuggestion {
  weight: number | null;
  reps: number | string | null;
  kind: 'up' | 'repeat' | 'down' | 'new';
  why: string;
}

/** Rounds where fewer reps than planned were done, 1-based. */
export function shortRounds(d: AssistDone): number[] {
  const planned = parseReps(d.reps)?.n;
  if (planned == null || !d.roundReps) return [];
  return d.roundReps.flatMap((x, i) => (parseReps(x) && parseReps(x)!.n < planned ? [i + 1] : []));
}

/** Smallest weight change seen on this exercise, else a dumbbell-ish default. */
export function weightStep(hist: AssistDone[]): number {
  const ws = [...new Set(hist.map((h) => h.weight).filter((w): w is number => w != null))].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < ws.length; i++) step = Math.min(step, ws[i] - ws[i - 1]);
  return Number.isFinite(step) && step > 0 ? step : 2;
}

/**
 * What to do next time, from the last time: repeat after missed reps or time off,
 * ease back after a long break, else +1 rep, or more weight at the top of the range.
 */
export function suggestAssist(hist: AssistDone[], range: string | null, today: string, trained: string | null): AssistSuggestion {
  const r = parseRange(range);
  const done = hist.filter((h) => parseReps(h.reps));
  const last = done[done.length - 1];
  if (!last) {
    return { weight: null, reps: r ? fmtReps(r.lo, r.unit) : null, kind: 'new', why: r ? `no history: start at the bottom of ${range}` : 'no history yet' };
  }
  const lr = parseReps(last.reps)!;
  const same = (why: string, kind: AssistSuggestion['kind'] = 'repeat'): AssistSuggestion => ({ weight: last.weight, reps: last.reps, kind, why });
  const gap = trained ? daysBetween(trained, today) : 0;
  if (gap >= 21) {
    const step = lr.unit ? 5 : 2;
    const n = Math.max(r?.unit === lr.unit ? r.lo : 1, lr.n - step);
    return { weight: last.weight, reps: fmtReps(n, lr.unit), kind: 'down', why: `${gap} days since the last workout: ease back in` };
  }
  if (gap >= 10) return same(`${gap} days since the last workout: repeat last time`);
  if (last.roundsDone === 0 && !last.roundReps) return same('no rounds ticked last time: repeat');
  const short = shortRounds(last);
  if (short.length) return same(`round${short.length > 1 ? 's' : ''} ${short.join(', ')} fell short last time: repeat`);
  if (last.roundsDone < Math.min(last.sets, last.roundsPlanned || last.sets)) {
    return same(`${last.roundsDone} of ${last.sets} rounds last time: repeat`);
  }
  const atTop = r?.hi != null && r.unit === lr.unit && lr.n >= r.hi;
  if (atTop && last.weight != null) {
    const w = +(last.weight + weightStep(hist)).toFixed(2);
    return { weight: w, reps: fmtReps(r!.lo, lr.unit), kind: 'up', why: `all rounds at ${last.reps}, the top of ${range}: more weight, back to ${r!.lo}` };
  }
  const plus = lr.unit ? 5 : 1;
  return {
    weight: last.weight, reps: fmtReps(lr.n + plus, lr.unit), kind: 'up',
    why: `all rounds at ${last.reps} last time: +${plus}${lr.unit}${atTop ? ' (top of range: add weight when you can)' : ''}`,
  };
}

// ---------- strength standards ----------

export interface StandardRow {
  name: string;
  /** Your number: best recent e1RM / bodyweight, or reps for a reps standard. */
  value: number | null;
  /** kg (or reps) behind the value. */
  basis: string | null;
  isReps: boolean;
  targets: number[];
  /** kg (reps) still missing to each level; <= 0 means reached. */
  missing: number[];
  /** Days to each level at the pace of the last 6 months, when rising. */
  eta: (number | null)[];
}

const RECENT_DAYS = 120;

function recent(list: Amrap[], today: string, days: number): Amrap[] {
  return list.filter((a) => daysBetween(a.date, today) <= days);
}

/** Least-squares slope of e1RM per day over the last `days`. */
export function paceKgPerDay(list: Amrap[], today: string, days = 180): number | null {
  const pts = recent(list, today, days);
  if (pts.length < 4) return null;
  const xs = pts.map((a) => -daysBetween(a.date, today)), ys = pts.map((a) => a.e1rm);
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let sxy = 0, sxx = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
  return sxx ? sxy / sxx : null;
}

/** Best recent e1RM (last 120 days, else ever) for a lift. */
export function currentE1rm(list: Amrap[], today: string): Amrap | null {
  return bestE1rm(recent(list, today, RECENT_DAYS)) ?? bestE1rm(list);
}

const PULL = /\b(chin|pull)/;

/** Chin-ups: bodyweight + added kg as an e1RM, and best bodyweight reps in one set. */
export function pullupStats(assist: Map<string, AssistDone[]>, bw: number, today: string): {
  weighted: { e1rm: number; weight: number; reps: number; date: string | null } | null;
  bwReps: { reps: number; date: string | null; name: string } | null;
} {
  let weighted: { e1rm: number; weight: number; reps: number; date: string | null } | null = null;
  let bwReps: { reps: number; date: string | null; name: string } | null = null;
  for (const [name, list] of assist) {
    if (!PULL.test(name)) continue;
    for (const d of list) {
      if (d.roundsDone === 0 && !d.roundReps) continue;
      const planned = parseReps(d.reps);
      if (!planned || planned.unit) continue;
      const best = Math.max(planned.n, ...(d.roundReps ?? []).map((x) => parseReps(x)?.n ?? 0));
      if (d.weight && d.weight > 0) {
        if (d.date && daysBetween(d.date, today) > 365) continue;
        const est = e1rm(bw + d.weight, planned.n);
        if (!weighted || est > weighted.e1rm) weighted = { e1rm: est, weight: d.weight, reps: planned.n, date: d.date };
      } else if (!bwReps || best > bwReps.reps) {
        bwReps = { reps: best, date: d.date, name: d.name };
      }
    }
  }
  return { weighted, bwReps };
}

export function standardsProgress(std: Standards, bw: number, history: History, assist: Map<string, AssistDone[]>, today: string): StandardRow[] {
  const pull = pullupStats(assist, bw, today);
  return std.rows.map((row) => {
    const name = normName(row.name);
    const isReps = /\bbw\b/.test(name);
    const key: LiftKey | null = name === 'squat' ? 'squat' : name === 'deadlift' ? 'deadlift' : name === 'bench' ? 'bench' : null;
    let value: number | null = null, basis: string | null = null, pace: number | null = null;
    if (key) {
      const list = liftHistory(history, key);
      const cur = currentE1rm(list, today);
      if (cur) { value = cur.e1rm / bw; basis = `e1RM ${cur.e1rm.toFixed(1)} kg (${cur.weight}×${cur.reps})`; }
      pace = paceKgPerDay(list, today);
    } else if (PULL.test(name) && isReps) {
      if (pull.bwReps) { value = pull.bwReps.reps; basis = `${pull.bwReps.reps} reps, ${pull.bwReps.name}`; }
    } else if (PULL.test(name)) {
      if (pull.weighted) { value = pull.weighted.e1rm / bw; basis = `bw +${pull.weighted.weight} kg × ${pull.weighted.reps}`; }
    }
    const missing = row.targets.map((t) => (value == null ? NaN : isReps ? t - value : (t - value) * bw));
    const eta = missing.map((m) => (pace && pace > 0 && m > 0 ? Math.round(m / pace) : null));
    return { name: row.name, value, basis, isReps, targets: row.targets, missing, eta };
  });
}

// ---------- overview ----------

const weekStart = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

export interface Overview {
  sessions: number;
  first: string | null;
  perMonth: { month: string; n: number }[];
  currentStreakWeeks: number;
  longestStreakWeeks: number;
  breaks: { from: string; to: string; days: number }[];
  tonnage: number;
  tonnageSince: string | null;
  amraps: number;
  amrapReps: number;
  prs: number;
  prsThisYear: number;
  avgSecs: number | null;
  timedSessions: number;
}

export function overview(sessions: PastSession[], today: string, months = 12): Overview {
  const dated = sessions.filter((s) => s.date).map((s) => s.date!).sort();
  const perMonth: { month: string; n: number }[] = [];
  const [ty, tm] = today.split('-').map(Number);
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(ty, tm - 1 - i, 1));
    const month = d.toISOString().slice(0, 7);
    perMonth.push({ month, n: dated.filter((x) => x.startsWith(month)).length });
  }
  const weeks = [...new Set(dated.map(weekStart))].sort();
  let longest = 0, run = 0, prev = '';
  for (const w of weeks) {
    run = prev && daysBetween(prev, w) === 7 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = w;
  }
  const thisWeek = weekStart(today);
  const lastWeek = weeks[weeks.length - 1];
  const current = lastWeek && daysBetween(lastWeek, thisWeek) <= 7 ? run : 0;
  const breaks: Overview['breaks'] = [];
  for (let i = 1; i < dated.length; i++) {
    const days = daysBetween(dated[i - 1], dated[i]);
    if (days > 14) breaks.push({ from: dated[i - 1], to: dated[i], days });
  }
  const withTon = sessions.filter((s) => s.tonnage != null || s.summary?.tonnage != null);
  const amraps = sessions.flatMap((s) => s.amraps);
  const timed = sessions.filter((s) => s.summary?.secs);
  const year = today.slice(0, 4);
  return {
    sessions: dated.length,
    first: dated[0] ?? null,
    perMonth,
    currentStreakWeeks: current,
    longestStreakWeeks: longest,
    breaks,
    tonnage: withTon.reduce((t, s) => t + (s.summary?.tonnage ?? s.tonnage ?? 0), 0),
    tonnageSince: withTon.find((s) => s.date)?.date ?? null,
    amraps: amraps.length,
    amrapReps: amraps.reduce((t, a) => t + a.reps, 0),
    prs: amraps.filter((a) => a.pr).length,
    prsThisYear: sessions.filter((s) => s.date?.startsWith(year)).flatMap((s) => s.amraps).filter((a) => a.pr).length,
    avgSecs: timed.length ? timed.reduce((t, s) => t + s.summary!.secs!, 0) / timed.length : null,
    timedSessions: timed.length,
  };
}

/** AMRAP reps for a lift in each week of each cycle (the first of the week's AMRAPs on that lift). */
export function amrapGrid(cycles: Cycle[], key: LiftKey): { cycle: string; number: number; weeks: ({ weight: number; reps: number } | null)[] }[] {
  return [...cycles].sort((a, b) => a.number - b.number).map((c) => ({
    cycle: c.name, number: c.number,
    weeks: c.weeks.map((w) => {
      for (const d of w.days) {
        const hit = sheetAmraps(d).find((a) => a.key === key);
        if (hit) return { weight: hit.weight, reps: hit.reps };
      }
      return null;
    }),
  })).filter((r) => r.weeks.some(Boolean));
}

/** Week-3 AMRAP reps down two cycles in a row. */
export function stalled(grid: ReturnType<typeof amrapGrid>): boolean {
  const w3 = grid.map((r) => r.weeks[2]?.reps).filter((x): x is number => x != null);
  const n = w3.length;
  return n >= 3 && w3[n - 1] < w3[n - 2] && w3[n - 2] < w3[n - 3];
}

/** Best reps at each weight, heaviest first. */
export function repPrBoard(list: Amrap[]): Amrap[] {
  const by = new Map<number, Amrap>();
  for (const a of list) {
    const b = by.get(a.weight);
    if (!b || a.reps > b.reps) by.set(a.weight, a);
  }
  return [...by.values()].sort((a, b) => b.weight - a.weight);
}

// ---------- next cycle ----------

export interface TmProposal {
  key: LiftKey;
  current: number;
  /** Week-3 AMRAPs on this lift, in day order. The rule uses the last one. */
  week3: { day: number; weight: number; reps: number }[];
  byRule: number | null;
  steps: number | null;
  /** 90% of the best e1RM of the last 60 days. */
  fromE1rm: number | null;
}

export const roundTm = (x: number) => Math.round(x / 1.25) * 1.25;

export function proposeTms(cycle: Cycle, history: History, today: string): TmProposal[] {
  const week3 = cycle.weeks.find((w) => w.week === 3);
  return (Object.keys(cycle.tm) as LiftKey[]).filter((k) => cycle.tm[k] != null).map((key) => {
    const current = cycle.tm[key]!;
    const w3 = (week3?.days ?? []).flatMap((d) => sheetAmraps(d).filter((a) => a.key === key).map((a) => ({ day: d.day, weight: a.weight, reps: a.reps })));
    const last = w3[w3.length - 1];
    const steps = last ? tmSteps(last.reps) : null;
    const best = bestE1rm(recent(liftHistory(history, key), today, 60));
    return {
      key, current, week3: w3, steps,
      byRule: steps != null ? current + steps * tmIncrement(key) : null,
      fromE1rm: best ? roundTm(best.e1rm * 0.9) : null,
    };
  });
}

