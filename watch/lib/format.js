// Small text helpers shared by the watch page and store.

export const LIFT_LABEL = {
  squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', press: 'Press', wide_bench: 'Wide bench',
};

export const liftName = (l) => (l.key ? LIFT_LABEL[l.key] : l.name);

/** Loadable weights: up to 2 decimals, no trailing zeros. */
export const kg = (x) => `${+Number(x).toFixed(2)}`;

/** Estimates (e1RM): one decimal. */
export const kg1 = (x) => `${+Number(x).toFixed(1)}`;

export function clock(secs) {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

export const hhmm = (ms) => {
  const d = new Date(ms);
  const m = d.getMinutes();
  return `${d.getHours()}:${m < 10 ? '0' : ''}${m}`;
};
