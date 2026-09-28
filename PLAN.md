# 5/3/1 Workout App: Plan

Goal: a phone-first app for logging during a session and seeing progress, with the Google Sheet as the only database and source of truth.

## Architecture

```
Phone (installable web app / PWA)  <--JSON over HTTPS-->  Apps Script API (bound to sheet)  <-->  Google Sheet
   - UI, rest timer, charts                                  - doGet: read cycle + history
   - offline write queue (IndexedDB)                         - doPost: write inputs, create cycle
```

- **Frontend:** PWA built with Vite + Preact + TypeScript. Installs to the Android home screen, works fullscreen, no Play Store. Charts with uPlot (tiny, fast).
- **Backend:** Google Apps Script web app attached to the sheet. Runs as the owner, so no Cloud project, no key file. Protected by a secret token stored in the app.
- **Hosting:** GitHub Pages (free, static).
- **Why not native Android:** a PWA gets home-screen install, vibration, wake lock and offline use. Native adds build tooling for no real gain here.
- **Why not serve the UI from Apps Script:** Apps Script HTML runs in a sandboxed iframe, is slow to load, and cannot work offline. Gym signal is often bad.

## Data rules
- The app writes **inputs only**: AMRAP reps, set checkboxes, assistance weight/reps. The sheet keeps computing weights, plates and supplemental %.
- A cell-map module encodes the cycle-tab layout (week rows 4/30/56, day blocks at columns B/M/X/AI). Only cycle8+ layout is supported for writes.
- History for charts comes from "rm calc" plus the TM row of every cycle tab, including old layouts.
- Every AMRAP is written to both the cycle tab and a new "rm calc" row, so double entry goes away. The rm calc row uses the weight actually lifted.
- **Deviations are first-class.** Every set is `done`, `changed` (actual weight/reps differ) or `skipped`, with an optional note. Swapped assistance exercises and unplanned extras are also recorded.
  - A new append-only **`session log`** tab gets one row per action: planned vs actual, status, note and timestamp. This is the full record, and progress screens read it.
  - The cycle tab stays readable as before. Changed or skipped sets get the checkbox (ticked or unticked) plus a cell note prefixed `app:`. Formulas are never overwritten.
  - Each write carries an op id, so an offline retry never double-writes.
- Writes are queued locally and flushed when online. The UI never blocks on the network.

## Features

### Session mode (the core)
1. **Today's workout, auto-picked.** The app finds the first unfinished day in the newest cycle and opens it. Manual override to pick any day.
2. **One big card per set.** Shows target weight, reps, and a **plate diagram** per side computed from your actual plate inventory, not just "kg per side".
   - Loadings are planned across the lift's whole sequence (warm-ups → main → 5x5) to **minimise plates put on / taken off**, not per set. The sleeve is a stack (outer plates come off first), so 20+5 → 20+5+5 is 1 change where 20+5 → 20+10 is 2. Only plates you own are used. Implemented in `src/plates.ts`.
   - Gym availability changes day to day. Default: plenty of 20/15/10/5, one pair of 2.5 and 1.25. A plate strip on the session screen lets you tap a size to mark it gone or set how many pairs are free today; the rest of the session replans instantly. The last-used state is remembered.
   - Replanned live after a change (e.g. the 5x5 weight moves after the AMRAP, or you load something else).
3. **Tap to complete, long-press to deviate.** A tap checks the set in the sheet and starts the **rest timer** (defaults: 3 min main, 2 min supplemental, 90 s assistance). Phone vibrates when rest ends. Screen stays awake. Long-press (or a "changed / skip" button) opens weight/reps steppers prefilled from the plan, plus a note field.
4. **AMRAP helper.** Before the AMRAP set it shows:
   - reps needed to **beat your best estimated 1RM** for that lift,
   - your rep PR at this exact weight,
   - reps needed to hit the next TM-progression tier (10 / 15 / 20).
5. **Live supplemental update.** After you enter AMRAP reps, the 5x5 weight updates immediately using the same rule as the sheet.
6. **Assistance with memory.** Each exercise shows what you did last time and the target range from "assistance plan". A "go heavier" hint appears when you hit the top of the range on all sets.
7. **Session summary.** Volume, AMRAP result, new PRs, a confetti moment when a PR is set, and a list of what deviated from the plan.

### Progress
8. **Estimated 1RM chart** per lift from "rm calc" (135 sessions since Sept 2024), with a trend line.
9. **Training max history** across all 15 cycles.
10. **PR board.** Best reps at each weight, best estimated 1RM, and dates.
11. **Strength vs bodyweight.** Uses your bodyweight and the intermediate/advanced/elite ratios already in the sheet. This also fixes the broken 1RM references there.
12. **Deviation stats.** Skip/change rate per lift and exercise over time. Shows what you routinely drop and when plans don't fit.
13. **Stall warning.** If AMRAP reps drop for two cycles in a row on a lift, suggest a 10% TM reset.

### Cycle rollover
14. **Next-cycle wizard.** After week 3 it proposes new TMs using your rule (<10 +1x, <15 +2x, <20 +3x, 20+ +4x). You adjust, confirm, and it duplicates the tab as the next cycle with new TMs and cleared inputs.

### Later / optional
- Deload week and warm-up routine as simple checklists.
- Bodyweight and waist quick entry with a chart.
- Notes per set, synced to a cell comment.

## Build phases
| Phase | Deliverable | Needs from you |
|---|---|---|
| 0 | Apps Script API (`apps-script/api.gs`): read + write endpoints, token, session log. **Written and tested against a mock of the sheet.** | Deploy it (see README steps). |
| 1 | Read-only session view with plate diagrams. Installable PWA. | Plate inventory and bar weight. |
| 2 | Logging: checkboxes, AMRAP, assistance, rest timer, offline queue, rm calc auto-row. | Test one real session. |
| 3 | Progress screens (charts, PR board, strength standards, stall warning). | none |
| 4 | Next-cycle wizard. | Confirm the rollover rule. |

Phases 1 and 2 give a usable gym app. Each phase is independently useful.

## Assumptions
- Single user, Android phone, kg units, 20 kg bar.
- Plates: 20, 15, 10, 5, 2.5, 1.25 kg (no 25s). Default: plenty of 20/15/10/5, one pair each of 2.5/1.25; adjusted per session in the app.
- Estimated 1RM formula stays as in the sheet: weight * (1 + (reps-1)/40).
- The sheet link goes back to Restricted once the API works.

## Risks
- **Layout drift.** If you restructure the cycle tab, the cell map breaks. Mitigation: a startup check reads header cells and warns instead of writing to wrong cells.
- **Token leak.** Anyone with the token could write to the sheet. Acceptable for workout data. The token can be rotated in one place.
- **Apps Script latency** is about 1-2 s per call. The offline queue hides it.
