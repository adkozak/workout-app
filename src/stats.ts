// AMRAP and progress stats. Estimated 1RM = weight * exp(0.03 * (reps - 1)):
// every extra rep is worth 3% of weight. Fitted to the logged AMRAPs so that
// e1RM does not jump when the weight steps up or down between close sessions
// (the sheet's weight * (1 + (reps - 1) / 40) made week 3 look ~2% stronger than
// week 2 on squat). Stays within ~2% of Epley up to 15 reps.

import type { Cycle, History, LiftKey } from './api.ts';

export interface Amrap { date: string; weight: number; reps: number; e1rm: number }

const PER_REP = 0.03;

export function e1rm(weight: number, reps: number): number {
  return weight * Math.exp(PER_REP * (reps - 1));
}

/** Fewest reps at `weight` whose estimated 1RM is strictly above `target`. */
export function repsToBeat(target: number, weight: number): number {
  return Math.max(1, Math.floor(Math.log(target / weight) / PER_REP + 1 + 1e-9) + 1);
}

/** All logged AMRAPs for a lift, oldest first. */
export function liftHistory(history: History, key: LiftKey): Amrap[] {
  return history.sessions
    .filter((s) => s.lifts[key])
    .map((s) => {
      const { weight, reps } = s.lifts[key]!;
      return { date: s.date, weight, reps, e1rm: e1rm(weight, reps) };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function bestE1rm(list: Amrap[]): Amrap | null {
  return list.reduce<Amrap | null>((b, a) => (!b || a.e1rm > b.e1rm ? a : b), null);
}

/** Most reps ever done at exactly this weight. */
export function repPrAt(list: Amrap[], weight: number): Amrap | null {
  return list
    .filter((a) => Math.abs(a.weight - weight) < 1e-9)
    .reduce<Amrap | null>((b, a) => (!b || a.reps > b.reps ? a : b), null);
}

/** The AMRAP for the same lift and week in another cycle tab (e.g. last cycle's week 3). */
export function sameWeekIn(cycle: Cycle | null, week: number, key: LiftKey): { weight: number; reps: number } | null {
  const w = cycle?.weeks.find((x) => x.week === week);
  for (const d of w?.days ?? []) {
    for (const l of d.lifts) {
      if (l.key !== key) continue;
      const s = l.sets.find((x) => x.kind === 'amrap');
      if (s?.actual != null) return { weight: s.weight, reps: s.actual };
    }
  }
  return null;
}

/** Best e1RM in the last `days` days minus best in the `days` before that. */
export function trend(list: Amrap[], days: number, today = new Date()): number | null {
  const iso = (n: number) => new Date(today.getTime() - n * 86400e3).toISOString().slice(0, 10);
  const recentFrom = iso(days), priorFrom = iso(2 * days);
  const prior = bestE1rm(list.filter((a) => a.date >= priorFrom && a.date < recentFrom));
  const recent = bestE1rm(list.filter((a) => a.date >= recentFrom));
  return prior && recent ? recent.e1rm - prior.e1rm : null;
}

export function mround(x: number, step = 2.5): number {
  return Math.round(x / step) * step;
}

/** Supplemental 5x5 % by AMRAP reps, as in the sheet: <10 first %, <15 second, else third. */
export function supplementalPct(reps: number, mainPcts: number[]): number {
  return reps < 10 ? mainPcts[0] : reps < 15 ? mainPcts[1] : mainPcts[2];
}

/** Next-cycle TM bump by week-3 AMRAP reps: <10 +1x, <15 +2x, <20 +3x, 20+ +4x. */
export function tmSteps(reps: number): number {
  return reps < 10 ? 1 : reps < 15 ? 2 : reps < 20 ? 3 : 4;
}

export function tmIncrement(key: LiftKey): number {
  return key === 'squat' || key === 'deadlift' ? 2.5 : 1.25;
}

export interface RepRow { reps: number; e1rm: number; beatsBest: boolean; isRepPr: boolean; suppWeight: number | null; tmBump: number | null }

/** What each rep count at `weight` would mean. */
export function repTable(opts: {
  weight: number; minReps: number; list: Amrap[]; tm: number | undefined;
  mainPcts: number[]; key: LiftKey; week: number; lastReps?: number;
}): RepRow[] {
  const best = bestE1rm(opts.list);
  const pr = repPrAt(opts.list, opts.weight);
  const beat = best ? repsToBeat(best.e1rm, opts.weight) : opts.minReps;
  const top = Math.min(30, Math.max(opts.minReps + 6, beat + 2, (pr?.reps ?? 0) + 2));
  // Start a few reps below the interesting marks, not at "1" for a 1+ set.
  const anchor = Math.min(beat, pr?.reps ?? beat, opts.lastReps ?? beat);
  const bottom = Math.max(opts.minReps, Math.min(anchor - 3, top - 8));
  const rows: RepRow[] = [];
  for (let r = bottom; r <= top; r++) {
    const est = e1rm(opts.weight, r);
    rows.push({
      reps: r,
      e1rm: est,
      beatsBest: !!best && est > best.e1rm,
      isRepPr: !pr || r > pr.reps,
      suppWeight: opts.tm && opts.mainPcts.length === 3 ? mround(supplementalPct(r, opts.mainPcts) * opts.tm) : null,
      tmBump: opts.week === 3 ? tmSteps(r) * tmIncrement(opts.key) : null,
    });
  }
  return rows;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400e3);
}
