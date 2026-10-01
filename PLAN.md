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

## Beyond the workout: the app replaces the sheet

The workout itself is covered. Four other jobs still send you to the sheet. The app takes each over, with the sheet staying the only store.

App layout: a tab bar with **Today · History · Progress · Cycle**. Today is the current home screen (and the workout while one is open).

### Data it needs (backend)
- `GET ?action=archive`: every cycle tab from cycle8 on, read in full like `cycle`, plus the target rep ranges from "assistance plan" (the `final:` list). It is about 8 tab reads, so the app fetches it only when History, Progress or Cycle opens, and caches it.
- A cycle read also returns:
  - the strength-standard targets (AW6:BE12)
  - per assistance exercise, the note and the per-round reps written in the round cells (e.g. `4 | 4` when the last rounds fell short)
- The TM rows in `history` also carry each cycle's bodyweight (AX6).
- New ops:
  - `bodyweight`: writes AX6 of the current cycle; the session log row keeps the history.
  - `new_cycle`: copies the newest tab as cycleN+1, puts it first, writes the TMs and clears the inputs. Formulas, lift names, warm-ups and assistance names stay.
- **Past sessions get dates.** rm calc has a date per AMRAP session. The app walks the cycle tabs day by day and matches each day's AMRAPs (lift, weight, reps) to the next rm calc rows. Days logged by the app take their date from the session log. rm calc rows from cycle1–7 (old layout) show up as AMRAP-only sessions.

### 1. Progress (stats)
- **Per lift:**
  - e1RM over time, with the TM as a step line and PRs marked
  - best e1RM, and change over 90 days and since the start
  - rep-PR board (best reps at each weight)
  - AMRAP reps per week of each cycle, to show stalls
- **Fuckarounditis targets:**
  - best recent e1RM ÷ bodyweight against intermediate/advanced/elite, read from the sheet's block (2y/5y/10y)
  - kg still missing to each level
  - at the pace of the last 6 months, when you'd get there
  - chin-ups: bodyweight + added weight from the weighted chin-up sets, and best bodyweight reps
  - bodyweight quick entry
- **Overview:**
  - sessions, training days per month, current and longest weekly streak, breaks longer than 2 weeks
  - total kg moved, average workout time (app era), AMRAPs logged, PRs this cycle
- **Stall warning:** week-3 AMRAP reps falling for two cycles in a row on a lift.

### 2. New cycle
- A wizard on the Cycle tab, offered once week 3 is done (or any time). For each lift it shows:
  - last cycle's week-3 AMRAP
  - the rule's bump (<10 +1x, <15 +2x, <20 +3x, 20+ +4x; x = 2.5 lower, 1.25 upper)
  - the resulting TM, and what TM your best recent e1RM would give (90%)
- **After a break** (more than 14 days since the last session) it says so, and offers per lift: keep, −5%, −10%, or 90% of recent e1RM.
- Every TM has a stepper. Bodyweight is set on the same screen.
- Create writes the tab (`new_cycle`) and reloads.

### 3. Assistance planning
Before a workout, the Today screen has an **Assistance plan** card. Per exercise it shows:
- the last 4–6 times you did it, with date, weight × reps, rounds done, rounds that fell short, and notes
- the target range from "assistance plan"
- days since you last trained, and since you last did this exercise
- a suggestion with its reason, such as:
  - "all 5 rounds at 12 last time, top of 10–15: +1 kg"
  - "3 weeks off: repeat the last weight at −2 reps"
  - "missed reps in rounds 4–5: repeat"

One tap takes the suggestion; the steppers adjust it. The values go to the cycle tab (`assist` op, status `planned`), where the workout picks them up.

### 4. History
- A list of sessions, newest first, grouped by cycle. Each row shows:
  - date and W/D
  - the lifts with AMRAP result and e1RM
  - PR badges
  - duration, kg moved and RPE when the app logged it
- A session opens to its full detail:
  - every set as planned, with done/changed/skipped and notes
  - AMRAP with e1RM and how it ranked at the time
  - 5×5 completion
  - assistance with weight × reps, rounds and per-round reps
  - for app-logged sessions: timing per set and heart rate
- Swipe or arrow buttons move to the previous or next session.

### Later / optional
- Deload week and warm-up routine as simple checklists.
- Bodyweight and waist quick entry with a chart.
- Notes per set, synced to a cell comment.

## Build phases
| Phase | Deliverable | Needs from you |
|---|---|---|
| 0 | Apps Script API (`apps-script/api.gs`): read + write endpoints, token, session log. **Written and tested against a mock of the sheet.** | Deploy it (see README steps). |
| 1 | Read-only session view with plate diagrams. Installable PWA. **Done.** | |
| 2 | Logging: checkboxes, AMRAP, assistance, rest timer, offline queue, rm calc auto-row. **Built; click-tested against a mocked backend.** Includes squat-first ordering, plate add/remove steps, live stats, PR confetti, per-step timing (session log `done at` / `secs since previous` / `secs since start`), and an offline app shell. | Test one real session. |
| 3 | Archive read, session dating, History tab. **Built.** Tested against a snapshot of the real sheet: 135 sessions dated. | |
| 4 | Progress tab: per-lift charts, PR board, fuckarounditis targets, overview stats, stall warning, bodyweight entry. **Built.** | |
| 5 | Assistance planning card on Today. **Built.** | Check the suggestions match how you'd pick. |
| 6 | Next-cycle wizard (`new_cycle`). **Built.** Tested on the dev server with the real snapshot. | Deploy the backend; try it once on the TEST sheet. |

Not built yet from the section above:
- per-set timing and heart rate charts
- deviation stats (skip/change rate per exercise)
- swipe between sessions (History has ‹ › buttons)
- TM steps for cycles 1–7 (their tabs aren't dated, so the TM line starts at cycle 8)

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
