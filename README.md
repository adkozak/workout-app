# 5/3/1 workout app

See `PLAN.md` for the design, `WATCH_PLAN.md` for the watch app, and `SHEET_STRUCTURE.md` for the sheet layout.

The phone app has four tabs:
- **Today:** the next workout, with an assistance planner (history, target range, suggestion); the workout itself runs here.
- **History:** every session since Sept 2024; tap one for all its sets, assistance and app timing.
- **Progress:** overview and fun stats, fuckarounditis targets against bodyweight, and per-lift e1RM/TM charts, AMRAP reps by cycle and rep PRs.
- **Cycle:** the current cycle, TM history, and the next-cycle wizard.

Pieces:
- `src/`: the phone app (PWA), plus logic shared with the watch and backend (`session.ts`, `plates.ts`, `stats.ts`, `live.ts`).
- `apps-script/`: the backend, bound to the sheet. `live.js` is generated from `src/live.ts` (`npm run gen`).
- `watch/`: the Zepp OS app for the Amazfit Active 2.
- `devserver/`: a local copy of the backend for testing; nothing reaches Google.

Node 22+ throughout.

## Backend (Apps Script)
Code lives in `apps-script/`; `secret.js` holds the API token (generated locally, gitignored).
Local-only, gitignored: `.clasp.json` (script ID), `.deployment-id` (web app deployment ID), `apps-script/secret.js` (token).

One-time: enable the Apps Script API at https://script.google.com/home/usersettings, run `npx clasp login`, and `.clasp.json` points at the sheet-bound script (gitignored).

Deploy a change: `npm run backend:deploy` (regenerates `live.js`, pushes all files and moves the existing deployment to a new version; the URL stays the same). Note `clasp push` replaces the remote files with `apps-script/`, so the existing `extractExerciseData` file must be pulled into that folder first.

## Test environments

There are two, so nothing you try touches the real sheet.

### 1. Local dev server (fastest, no Google at all)
```
npm run devserver                 # synthetic sheet: cycle8 done, cycle9 week 1 done
npm run devserver -- --snapshot   # a copy of your real data instead (see below)
npm run devserver -- --reset      # start over
```
It runs the real `apps-script/*.js` against an in-memory sheet and saves it in `devserver/data/state.json`. Open http://localhost:8787/ to see:
- setup links for the PWA and the watch
- the live workout
- every tab, so you can see what got written

Formulas are not recalculated. The apps compute the 5x5 weight themselves, so this only matters if you look at formula cells.

For a copy of your real data: File → Download → Microsoft Excel (.xlsx) in the sheet, save it as `log.xlsx` in this folder, then run `.venv/bin/python devserver/xlsx2json.py log.xlsx devserver/data/snapshot.json` (needs `openpyxl`).

- **PWA against it:** run `npm run dev -- --host` and open the PWA link from the dev server page. Use the LAN one on the phone. It is a different address from the real app, so the real app's settings and queue are untouched.
- **Watch against it:** paste the watch code from the dev server page into the watch app's settings in Zepp. The phone must be on the same Wi-Fi as this computer.

### 2. Test copy of the Google Sheet (real Apps Script, real redirects)
One-time setup:
1. Open the sheet → File → Make a copy. In the copy, go to Extensions → Apps Script → Project settings and copy the **Script ID**.
2. Run `npm run backend:test:init -- <scriptId>`. This:
   - writes `.clasp.test.json`
   - makes a separate token in `.secret.test`
   - pushes the code and creates a web app deployment
   - prints the URL and setup code
3. In the copy's Apps Script editor, pick `authorize` in the function list, press Run and allow access.

After that:
- `npm run backend:test:deploy` pushes changes to the test copy.
- `npm run backend:test:link` prints the setup code again.

Test setup links carry `name: "TEST"`, so the PWA shows a yellow TEST badge and the watch shows "5/3/1 · TEST".

The prod token never goes to the copy. The build in `.build/apps-script-test/` gets its own `secret.js`.

## Watch app (Amazfit Active 2)

The watch runs a whole workout:
- today's day is picked automatically
- one big DONE per set, with plates and plate changes
- rest countdown with vibration
- AMRAP rep counter showing what beats your records
- change/skip, pause, "do next", extra sets
- finish with RPE

Heart rate is recorded per set and for the whole workout. The watch and the phone app show the same workout and sync every few seconds through the backend's "live session". You can start on one and carry on on the other.

Setup:
1. In the Zepp app, turn on developer mode: Profile → Settings → About → tap the Zepp icon 7 times.
2. Also in Zepp, allow Zepp to run in the background: turn battery optimisation off for it in Android settings.
3. On this computer:
   - `npm run watch:install` (once)
   - `npx zeus login` (in `watch/`, once)
4. Install on the watch:
   - `npm run watch:preview` and scan the QR code in Zepp (Profile → your watch → Developer mode → Scan), **or**
   - `npm run watch:bridge` for live logs.
5. In Zepp, open the app's settings (Profile → your watch → App settings → Workout 531) and paste the setup link or code. Use a dev server or TEST code until you trust it.

Other commands:
- `npm run watch:build` makes a `.zab` in `watch/dist/`.
- `npm run watch:dev` runs the simulator. It is a separate download from https://docs.zepp.com/docs/guides/tools/simulator/download/.

`appId` in `watch/app.json` is a placeholder. If preview refuses it, create an app at https://console.zepp.com and put its id there.

On the watch:
- **Physical buttons** (except back) do the main action on screen: DONE, open the AMRAP counter, skip the rest. The bridge log prints the key codes, which is useful if a button does something else on your firmware.
- **Back or swipe right** during a workout opens the menu instead of leaving the app.

## Tests
`npm test` (Node 22+). It covers:
- the shared logic
- the backend, run against the fake sheet
- the watch's store and phone service
- a phone + watch sync round trip over HTTP
