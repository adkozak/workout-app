# Workout log sheet: structure

Program: Wendler 5/3/1, 4 training days/week, 3 weeks/cycle, one tab per cycle. Units: kg, 20 kg bar.

## Tabs
| Tab | Role |
|---|---|
| cycle15 (newest first) ... cycle1 | One cycle each. cycle8+ share the current layout (78 cols). cycle1-7 older layout (64 cols). |
| rm calc | Chronological log of AMRAP sets + estimated 1RM, feeds charts. |
| assistance plan | Assistance exercise selection and target rep ranges. |
| deload, deload2 | Deload week notes. |
| waist | Waist / bodyweight measurements (free-form, mixed layout). |
| rozcvicka | Warm-up routine (Slovak). |
| weight deprecated | Old bodyweight log with moving average. |
| intro | Initial testing notes. |

## Cycle tab (cycle15 layout)
- Row 1-2: training maxes. C2 Squat, D2 Bench, E2 Deadlift, F2 Press, G2 Wide bench.
- AU1:AW5: TM progression rule by week-3 AMRAP reps (<10 +1x, <15 +2x, <20 +3x, 20+ +4x, 25+ custom; x = 1.25 upper, 2.5 lower).
- AW6:BE12: strength standards vs bodyweight (AX6 = bodyweight).
- Weeks start at rows 4, 30, 56 (stride 26). Week label in column B.
- Days are side by side in 11-column blocks starting at columns B, M, X, AI:
  - Day 1: Squat + Bench
  - Day 2: Deadlift + Press
  - Day 3: Wide bench + Squat
  - Day 4: Deadlift + Press
- Within a week (offset from week row W):
  - W+1 lift name, W+2 headers: % | Weight | 1 side | sets | Reps | actual
  - W+3..W+5 fixed warm-up sets (hardcoded weights)
  - W+6..W+8 main sets: % of TM, weight = MROUND(%*TM, 2.5), plate per side = (w-20)/2
  - W+8 is the AMRAP set: Reps like "5+", "3+", "1+", "actual" column holds the rep count achieved
  - W+9 supplemental 5x5: % chosen by AMRAP reps (<10 first %, <15 second %, else third); 5 checkboxes across the actual column and next 4
  - W+10 second lift name, W+11..W+17 its sets: **no header row**, so warm-ups W+11..W+13, main W+14..W+16, supplemental W+17
  - Day 3 lift 1 is named "Bench" in cycle8-13 even though it is wide bench from cycle14; identify lifts by the TM cell in the weight formula ($C$2..$G$2), not by name.
  - Assistance round checkboxes are on the header row (W+19, 5 cells from the "actual" column), one per round, not per exercise.
  - W+18 "Assistance", W+19 headers (weight/sets/reps + 5 set checkboxes), W+20..W+23 four assistance exercises
- Set completion = checkbox (TRUE/FALSE) in the "actual" column; AMRAP = number.
- Week %: W1 65/75/85 (5,5,5+), W2 70/80/90 (3,3,3+), W3 75/85/95 (5,3,1+).
- Weights, per-side plates, and supplemental % are formulas. The app should write only inputs (AMRAP reps, checkboxes, assistance weight/reps) and read computed values.

## rm calc
- Row 2 headers. Data from row 3. Column B session number (formula), R date as TEXT "d.m.yyyy", S parsed date (formula).
- Weight/reps/1RM est triplets: C-E squat, F-H deadlift, I-K bench, L-N wide bench, O-Q overhead press.
- 1RM est = weight * (1 + (reps-1)/40).
- Each row is one session, only the day's two lifts filled. AMRAP data is entered twice today: once in the cycle tab, once here.
- A1/A2 hold "NEW SESSION" / "CURRENT SESSION" controls, likely an existing Apps Script (not visible in export).

## Quirks
- cycle15 week 3 day 4: deadlift warm-ups are 60/60/60 with reps 3/5/7, and the press AMRAP says "5+" instead of "1+".
- Strength-standard 1RM formulas in AZ8:AZ10 are #REF!.
- Dates are text in rm calc, real dates in weight deprecated. Mixed Slovak/English notes.

## session log (created by the app)
One row per app action: op id, logged at, session date, cycle, week, day, slot, exercise, kind, set, planned weight/reps, actual weight/reps, status (done/changed/skipped/undo), note.
