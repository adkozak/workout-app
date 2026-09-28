// Client for the Apps Script API (apps-script/api.js). The web app URL and
// token are never in the repo: they arrive once via a setup link
// (#setup=<base64url JSON>) and are kept in localStorage on the phone.

export type LiftKey = 'squat' | 'bench' | 'deadlift' | 'press' | 'wide_bench';

export interface SetRow {
  index: number;
  kind: 'warmup' | 'main' | 'amrap' | 'supplemental';
  cell: string;
  pct: number | null;
  weight: number;
  sets: number;
  reps: string;
  note: string | null;
  done?: boolean | boolean[];
  actual?: number | null;
}

export interface Lift { name: string; key: LiftKey | null; sets: SetRow[] }

export interface Assistance { index: number; name: string; weight: number | string | null; sets: number; reps: number | string | null }

export interface Day { day: number; lifts: Lift[]; assistance: Assistance[]; rounds: boolean[]; assistanceNote: string | null }

export interface Cycle {
  name: string;
  number: number;
  tm: Partial<Record<LiftKey, number>>;
  writable: boolean;
  layoutProblems: string[];
  bodyweight: number | null;
  weeks: { week: number; days: Day[] }[];
}

export interface History {
  sessions: { row: number; date: string; lifts: Partial<Record<LiftKey, { weight: number; reps: number }>> }[];
  trainingMaxes: { cycle: string; number: number; tm: Partial<Record<LiftKey, number>> }[];
  log: Record<string, unknown>[];
}

export interface Bootstrap { cycle: Cycle; previous: Cycle | null; history: History }

export interface Config { url: string; token: string }

const CONFIG_KEY = 'config';
const CACHE_KEY = 'bootstrap';

/** Accepts a full setup link or just the code after #setup= ; returns true if saved. */
export function saveSetup(input: string): boolean {
  const code = (/setup=([^&\s]+)/.exec(input)?.[1] ?? input).trim();
  try {
    const cfg = JSON.parse(atob(code.replace(/-/g, '+').replace(/_/g, '/'))) as Config;
    if (!cfg.url || !cfg.token) return false;
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    return true;
  } catch {
    return false;
  }
}

/** Reads #setup=... from the address bar, stores it, and removes it from the URL. */
export function consumeSetupLink(): void {
  if (!/[#&]setup=/.test(location.hash)) return;
  saveSetup(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
}

export function getConfig(): Config | null {
  const raw = localStorage.getItem(CONFIG_KEY);
  return raw ? (JSON.parse(raw) as Config) : null;
}

export function cachedBootstrap(): Bootstrap | null {
  const raw = localStorage.getItem(CACHE_KEY);
  return raw ? (JSON.parse(raw) as Bootstrap) : null;
}

export async function fetchBootstrap(cfg: Config): Promise<Bootstrap> {
  const url = `${cfg.url}?action=bootstrap&token=${encodeURIComponent(cfg.token)}`;
  const res = await fetch(url, { redirect: 'follow' });
  const body = (await res.json()) as { ok: boolean; data?: Bootstrap; error?: string };
  if (!body.ok || !body.data) throw new Error(body.error ?? `HTTP ${res.status}`);
  localStorage.setItem(CACHE_KEY, JSON.stringify(body.data));
  return body.data;
}

/** First day in the cycle whose AMRAPs are not all filled in. */
export function nextDay(cycle: Cycle): { week: number; day: Day } | null {
  for (const w of cycle.weeks) {
    for (const d of w.days) {
      const amraps = d.lifts.flatMap((l) => l.sets.filter((s) => s.kind === 'amrap'));
      if (amraps.some((s) => s.actual == null)) return { week: w.week, day: d };
    }
  }
  return null;
}
