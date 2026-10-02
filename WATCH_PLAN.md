# Watch app: Plan

Goal: run a whole session from the wrist on an **Amazfit Active 2** (Zepp OS 5, API_LEVEL 4.2, 2 buttons, no crown, touch). The phone stays in the bag. The PWA and the watch show the same session, and heart rate is logged per set.

## Architecture

```
Watch mini program  <--BLE (zml request/call)-->  Side service (JS inside the Zepp phone app)
   - session UI, rest timer, HR                     - fetch() to Apps Script
   - local session + op queue                       - holds URL/token (settingsStorage)
                                                          |
                                                        HTTPS
                                                          v
PWA (phone)  <--JSON over HTTPS (poll while a session is open)-->  Apps Script  <-->  Sheet
```

- A watch app's only Bluetooth link is to the Zepp phone app. A PWA can't talk to it, so **the watch and the PWA sync through Apps Script** rather than directly.
- The watch works fully offline. It keeps the session and an op queue in `LocalStorage` and flushes them whenever the side service is reachable. Ops keep their unique ids, so the backend dedupe in `doPost` still works as it does now.
- Setup: a Settings App page inside Zepp takes the same setup link the PWA uses and saves the URL and token in `settingsStorage`. The token never goes to the watch.

## Sync model (built)

`Session` (`src/session.ts`) is the merge unit. Merging lives in `src/live.ts`. The same code runs:
- in the PWA
- on the watch (bundled into `watch/lib/shared.js`)
- in Apps Script (generated `apps-script/live.js`)

Merge rules:
- **`entries`**: per item id, the one with the latest `at` wins. An undo is an `open` entry with its own time.
- **`extras`**: a union, minus the ids in `removedExtras` (tombstones).
- **Other fields** (lift order, cursor, paused, rounds, RPE, finished, HR summary): each change is stamped in `session.stamps`, and the latest stamp wins.
- **Workout identity**: `cycle/w<week>d<day>/<date>`. For two different workouts, the one that started later wins.
- **Closing** (saved or left) records `closed: {key, at}`. Other devices then drop that workout, and a stale copy can't bring it back.

Backend:
- `GET ?action=live` returns the live doc `{v, session, closed, inventory, hr}`.
- `POST {token, ops, live: {session?, close?, inventory?, hr?}}` applies the ops, merges the push and returns `{results, live}`.
- The doc sits in script properties, split into 4 kB chunks.

Clients:
- The device that performs an action also queues its sheet op. That op is the only write to the cycle tab, and backend dedupe makes retries safe.
- The watch syncs every 5 s during a workout (20 s when idle). The phone does the same while the app is visible.
- Each device pushes its session only when it differs from what the server last returned.
- The watch sends its current bpm about every 15 s. The phone shows it in the session header.
- An idle device picks up a workout started on the other one, but only if it's today's.

The side service trims `bootstrap` to about 25 kB for the watch:
- the cycle without cell refs and notes
- AMRAP history per lift
- last cycle's AMRAP per week
## Watch UX

The rule: **every action during a session is one tap or one button press**, with no aiming and no reading small text.

**Current set screen**
- Lift and set label: "Squat · 3/5".
- Weight × reps in the largest font the screen can fit.
- A plate line for each side: `20 + 5 + 1.25`, with the plate change from the previous set highlighted: `+5`.
- The **DONE** button fills the lower half of the screen.
- Heart rate and the session timer run across the top in small text.

**Actions**

| Action | Input |
|---|---|
| Set done | Tap DONE, **or press the lower button** (if the key can be intercepted, see risks) |
| Undo last | Long-press the lower button, or tap the "undo" toast (5 s) |
| Changed / skip | Swipe up: big −/+ steppers for reps and weight, prefilled from the plan; a Skip button |
| AMRAP | A rep picker that opens at the target and shows "N to beat e1RM" and your PR at that weight; confirm with DONE |
| Pause / do next | Swipe left: the list of groups, then tap one |
| Finish | Appears after the last item: summary, then RPE (1–10 buttons), then Save |

**Rest screen**
- A countdown ring in huge digits, with heart rate and "recovered to X bpm" underneath.
- A strong vibration at 0 and a light one at −10 s.
- +30 s button; X (or any physical button) skips the rest.
- When time is up the rest screen stays, showing the overtime in gold and buzzing every 6 s (for up to 2 minutes) until X. X stops the buzzing and moves on.
- Rest is 1:30 after every working set and assistance round, with none between warm-up sets (`restFor()`).

**Exercise overview**
- Before the first set of each lift, one screen lists:
  - the warm-ups
  - the three main sets with kg per side
  - the 5×5
- Before the first assistance round, it lists the four exercises with weight × reps.
- START (or a physical button) begins.

**Summary**
- Duration, volume, PRs (with a vibration pattern), average and max heart rate, and time in zones.

## Heart rate

- `HeartRate.onCurrentChange` (permission `data:user.hd.heart_rate`) runs while a session is open. Samples are kept in memory and saved every minute.
- Per set, it records heart rate at DONE, peak heart rate during the set, and heart rate at the end of rest. These are written to the op and go to new `session log` columns: `hr at done`, `hr peak`, `hr end rest`.
- Per session, it records average and max heart rate and time in each zone. Zones come from `Workout.getUserHrZoneSettings()` (API 4.2).
- Raw samples are thinned to one every 5 s and appended to a new `hr` tab when the session is saved.
- Calories: Zepp OS gives no per-workout calories, so they'd have to be estimated from heart rate. That can come later.
- The native Strength Training workout can't be extended on the Active 2, because Workout Extensions don't support this model. So this app **replaces** starting a native workout rather than running alongside it. Workouts won't show up in Zepp/Strava unless you also start one there; you can do both.

## Keeping the app alive

- By default, the system exits a mini program 10 s after the screen turns off. Plan:
  - v1 (simple, reliable):
    - `setPageBrightTime` for the length of the session
    - `pauseDropWristScreenOff({duration: 0})`
    - `setWakeUpRelaunch(true)` as a safety net
  - The screen stays on dimmed. Battery cost is about 1–1.5 h of AMOLED screen time, which needs measuring.
  - The rest timer is a `setTimeout` on the page, with an `@zos/alarm` backup set to the same end time. If the app gets killed, the alarm reopens the rest page and vibrates.
  - v2, only if battery is a problem: let the screen turn off. A continuous App Service (`device:os.bg_service`, which asks for your consent once) keeps reading heart rate, and alarms handle the rest-end vibration.

## Code layout

```
watch/
  app.json            # appId (placeholder), permissions, 4.2 targets incl. Active 2 (466x466 round)
  app.js              # zml BaseApp
  page/index.js       # the only page: home, set, rest, AMRAP, edit, menu, summary... (UI only)
  app-side/index.js   # side service in the Zepp phone app: forwards to lib/side.js
  setting/index.js    # settings page in Zepp: paste the setup link/code
  lib/store.js        # all watch state and logic, no Zepp APIs (unit-tested)
  lib/side.js         # package trimming, backend calls with manual redirects (unit-tested)
  lib/setup.js        # setup code parsing
  lib/format.js       # text helpers
  lib/shared.js       # GENERATED: src/{session,stats,plates,live,api}.ts bundled by scripts/gen.mjs
  test/               # store + side service + phone/watch round trip against devserver/
```

- The watch uses the phone app's own logic from `src/`, bundled by esbuild to ES2019 for QuickJS. The page is a thin view over `Store`.
- `zeus build` compiles to QuickJS bytecode, which catches syntax the watch can't run. It works offline. The Zepp analytics call it makes fails harmlessly.
- The watch UI sticks to Latin-1 text (no emoji or arrows), because the system font's coverage is unknown.

## Build status

| Phase | Status |
|---|---|
| 0 Proof of concept | Replaced by tests: the store, side service and backend run in Node against a fake sheet over HTTP with Apps Script-style redirects. **Still to check on the real watch:** button key codes, HR sample rate, fetch redirect behaviour, side service lifetime. |
| 1 Minimum version | Built |
| 2 Live sync | Built (`src/live.ts`, `src/liveSync.ts`, `watch/lib/store.js`) |
| 3 Heart rate | Per-set and session HR, `hr` tab, HR in the phone summary. **Not built:** HR charts in the progress screens, which don't exist yet (PLAN.md phase 3). |
| 4 Full logging | Built: change/skip, AMRAP helper, pause/do next, extra sets, rounds ±, RPE, plate changes. **Phone only:** per-exercise assistance edits and notes. |
| 5 Extras | **Not built:** shortcut card/widget, low-battery mode with a background service. The screen stays on during a workout; an alarm backs up the rest timer. |

Test environments are described in README.md: the local dev server, and a test copy of the sheet with its own deployment and token.

## Risks / unknowns (checked in phase 0)

- **Button interception.** The docs disagree on whether an app can catch a normal click on a 2-button device, or only long presses. If it can't, DONE is touch-only and the buttons handle long-press undo only.
- **Side service lifetime.** Android may kill the Zepp app in the background. Mitigations: turn off battery optimisation, and let the watch queue ops, so the only cost of a dead service is a delay in syncing.
- **Apps Script redirect.** Web requests to `script.google.com` get a 302 redirect, and the docs don't say whether the side service's `fetch` follows it. Fallback: a tiny proxy on a Cloudflare Worker.
- **Heart-rate sample rate** from `onCurrentChange` isn't documented. If it's slower than about 1 per 5 s, "peak during the set" becomes rough.
- **Battery** with the screen kept on for the whole session.
