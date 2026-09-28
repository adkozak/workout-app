// Plate planning for one lift's whole sequence (warm-ups, main sets, supplemental).
// Picks the loading per set that minimises plate handling across the sequence,
// not just the fewest plates per set. Each sleeve is a stack: to change a plate
// you first pull every plate outside it, so the cost of going from stack A to
// stack B is (|A| - common) + (|B| - common), where common is the shared prefix
// from the collar inwards. Stacks are kept heaviest-inside.

/** Plate weight in kg -> number of pairs owned. */
export type Inventory = Record<number, number>;

/** Typical gym state: big plates plentiful, usually one pair of each small one.
 * Adjusted per session in the app when the gym runs out of something. */
export const DEFAULT_INVENTORY: Inventory = { 20: 4, 15: 4, 10: 4, 5: 4, 2.5: 1, 1.25: 1 };

export interface Loading {
  /** Plates on one side, innermost first. */
  perSide: number[];
  /** Total bar weight this loading gives. */
  total: number;
  /** False if the target could not be loaded exactly with the inventory. */
  exact: boolean;
  /** Plates put on + taken off (per side) to get here from the previous set. */
  changes: number;
}

const MAX_EXTRA_PLATES = 3; // consider stacks up to this many plates above the minimum
const MAX_CANDIDATES = 300;
const PLATE_PENALTY = 0.3; // in plate changes; tuned on real sessions

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** All heaviest-inside stacks summing to perSide within the inventory. */
export function stacksFor(perSide: number, inv: Inventory): number[][] {
  const plates = Object.keys(inv).map(Number).filter((p) => inv[p] > 0).sort((a, b) => b - a);
  const out: number[][] = [];
  const stack: number[] = [];
  const go = (rest: number, from: number, used: Record<number, number>) => {
    if (Math.abs(rest) < 1e-9) { out.push([...stack]); return; }
    for (let i = from; i < plates.length; i++) {
      const p = plates[i];
      if (p > rest + 1e-9 || (used[p] ?? 0) >= inv[p]) continue;
      used[p] = (used[p] ?? 0) + 1;
      stack.push(p);
      go(round(rest - p), i, used);
      stack.pop();
      used[p]--;
    }
  };
  go(round(perSide), 0, {});
  if (out.length === 0) return out;
  const min = Math.min(...out.map((s) => s.length));
  return out
    .filter((s) => s.length <= min + MAX_EXTRA_PLATES)
    .sort((a, b) => a.length - b.length)
    .slice(0, MAX_CANDIDATES);
}

function changeCost(a: number[], b: number[]): number {
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return a.length - common + (b.length - common);
}

/** Candidates for a target total; falls back to the nearest loadable weight. */
function candidatesFor(total: number, inv: Inventory, bar: number): { stacks: number[][]; total: number; exact: boolean } {
  if (total <= bar) return { stacks: [[]], total: bar, exact: Math.abs(total - bar) < 1e-9 };
  const smallest = Math.min(...Object.keys(inv).map(Number).filter((p) => inv[p] > 0));
  const perSide = round((total - bar) / 2);
  const steps = Math.ceil(perSide / (smallest / 2));
  for (let k = 0; k <= steps; k++) {
    for (const x of k === 0 ? [perSide] : [round(perSide - k * smallest / 2), round(perSide + k * smallest / 2)]) {
      if (x < 0) continue;
      const stacks = x === 0 ? [[]] : stacksFor(x, inv);
      if (stacks.length) return { stacks, total: round(bar + 2 * x), exact: k === 0 };
    }
  }
  throw new Error(`cannot load ${total} kg with this inventory`);
}

/**
 * Plan loadings for a sequence of target weights (kg, whole bar).
 * Starts from an empty bar; stripping after the last set is not counted.
 */
export function planLoadings(targets: number[], inv: Inventory, bar = 20): Loading[] {
  if (targets.length === 0) return [];
  const cands = targets.map((t) => candidatesFor(t, inv, bar));
  // Cost: plate changes, plus a small charge per plate on the bar so plentiful
  // small plates don't turn into tall stacks (57.5 as 5+5+5+2.5+1.25).
  const score = (changes: number, plates: number) => changes + PLATE_PENALTY * plates;

  let best = cands[0].stacks.map((s) => ({ cost: score(s.length, s.length), prev: -1 }));
  const back: number[][] = [best.map((b) => b.prev)];
  for (let i = 1; i < cands.length; i++) {
    const cur = cands[i].stacks.map((s) => {
      let bestCost = Infinity, bestPrev = -1;
      cands[i - 1].stacks.forEach((p, j) => {
        const c = best[j].cost + score(changeCost(p, s), s.length);
        if (c < bestCost) { bestCost = c; bestPrev = j; }
      });
      return { cost: bestCost, prev: bestPrev };
    });
    back.push(cur.map((c) => c.prev));
    best = cur;
  }
  let idx = 0;
  best.forEach((b, j) => { if (b.cost < best[idx].cost) idx = j; });

  const picks: number[] = [];
  for (let i = cands.length - 1; i >= 0; i--) { picks.unshift(idx); idx = back[i][idx]; }
  return picks.map((j, i) => {
    const perSide = cands[i].stacks[j];
    const prev = i === 0 ? [] : cands[i - 1].stacks[picks[i - 1]];
    return { perSide, total: cands[i].total, exact: cands[i].exact, changes: changeCost(prev, perSide) };
  });
}

/** Per-side loading steps from one stack to the next: pull `remove` (outermost first), then slide on `add`. */
export function plateSteps(from: number[], to: number[]): { remove: number[]; add: number[] } {
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  return { remove: from.slice(common).reverse(), add: to.slice(common) };
}
