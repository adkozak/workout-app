# 5/3/1 workout app

See `PLAN.md` for the design and `SHEET_STRUCTURE.md` for the sheet layout.

## Backend (Apps Script)
Code lives in `apps-script/`; `secret.js` holds the API token (generated locally, gitignored).
Local-only, gitignored: `.clasp.json` (script ID), `.deployment-id` (web app deployment ID), `apps-script/secret.js` (token).

One-time: enable the Apps Script API at https://script.google.com/home/usersettings, run `npx clasp login`, and `.clasp.json` points at the sheet-bound script (gitignored).

Deploy a change: `npm run backend:deploy` (pushes all files and moves the existing deployment to a new version; the URL stays the same). Note `clasp push` replaces the remote files with `apps-script/`, so the existing `extractExerciseData` file must be pulled into that folder first.

## Tests
`node --experimental-strip-types --test src/plates.test.ts` (Node 22+).
