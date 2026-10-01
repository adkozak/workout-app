// JSON API for the 5/3/1 PWA. Lives next to extractExerciseData() in the same
// Apps Script project; every helper here ends in "_" so nothing clashes.
//
// GET  ?token=..&action=ping|cycle|history|bootstrap|archive|live[&name=cycle15]
//      (bootstrap without a name picks the cycle in progress; see currentCycle_;
//       archive is every cycle8+ tab in full plus the assistance plan, for the
//       History/Progress/Cycle screens)
// POST body (Content-Type: text/plain, avoids CORS preflight):
//      {"token": "..", "ops": [{"id": "..", "type": "set"|"assist"|"assist_round"|"rm"|"extra"|"hr"|"bodyweight"|"new_cycle", ...}],
//       "live": {session?, close?, inventory?, hr?}}   (optional; see src/live.ts)
// The live session (the workout in progress, shared by phone and watch) lives in
// script properties; merging is done by Live.applyPush from live.js, which is
// generated from src/live.ts.

var MIN_WRITABLE_CYCLE = 8;           // cycle8+ share the current layout
var WEEK_ROWS = [4, 30, 56];          // "Week n" label rows
var DAY_COLS = [2, 13, 24, 35];       // day blocks start at B, M, X, AI
var BLOCK_ROWS = 82;                  // rows 1..82 cover all three weeks
var BLOCK_COLS = 58;                  // A..BF covers day blocks + rule/standards area
var TM_COLS = { C: 'squat', D: 'bench', E: 'deadlift', F: 'press', G: 'wide_bench' };
var RM_LIFTS = [                      // rm calc weight/reps/1RM triplets
  ['squat', 3], ['deadlift', 6], ['bench', 9], ['wide_bench', 12], ['press', 15]
];
var RM_DATE_COL = 18;                 // R
var LOG_SHEET = 'session log';
var LOG_HEADERS = ['op id', 'logged at', 'session date', 'cycle', 'week', 'day', 'slot',
  'exercise', 'kind', 'set', 'planned weight', 'planned reps', 'actual weight',
  'actual reps', 'status', 'note', 'done at', 'secs since previous', 'secs since start',
  'hr done', 'hr peak', 'hr low', 'hr avg'];
var HR_SHEET = 'hr';
var HR_HEADERS = ['session date', 'started at', 'time', 'secs since start', 'bpm'];
var LIVE_KEY = 'live';
var CURRENT_KEY = 'current cycle';    // set by new_cycle: train this tab even if the one before is unfinished
var BW_CELL = 'AX6';
var PLAN_SHEET = 'assistance plan';
var LIVE_CHUNK = 4000;                // script properties hold 9 kB per value; notes may be 2-byte UTF-8
var NOTE_PREFIX = 'app: ';            // only notes with this prefix are ever cleared
var SET_KINDS = ['warmup', 'warmup', 'warmup', 'main', 'main', 'amrap', 'supplemental'];

function doGet(e) {
  return respond_(function () {
    auth_(e.parameter.token);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    switch (e.parameter.action) {
      case 'ping': return { now: new Date().toISOString(), cycles: cycleNames_(ss) };
      case 'cycle': return readCycle_(ss, e.parameter.name || newestCycle_(ss));
      case 'history': return readHistory_(ss);
      case 'live': return readLive_();
      case 'archive': return readArchive_(ss);
      case 'bootstrap': {
        var read = cycleReader_(ss);
        var cycle = currentCycle_(ss, e.parameter.name, read);
        var prev = 'cycle' + (cycle.number - 1);
        return {
          cycle: cycle,
          previous: ss.getSheetByName(prev) ? read(prev) : null,
          history: readHistory_(ss)
        };
      }
      default: throw new Error('unknown action: ' + e.parameter.action);
    }
  });
}

function doPost(e) {
  return respond_(function () {
    var body = JSON.parse(e.postData.contents);
    auth_(body.token);
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var ops = body.ops || [];
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      // A live-only sync (every few seconds during a workout) skips reading the whole log.
      var log = ops.length ? logSheet_(ss) : null;
      var seen = ops.length ? seenOpIds_(log) : {};
      var results = ops.map(function (op) {
        if (!op.id) return { id: null, status: 'error', error: 'op without id' };
        if (seen[op.id]) return { id: op.id, status: 'duplicate' };
        try {
          applyOp_(ss, op);
          appendLog_(log, op);
          seen[op.id] = true;
          return { id: op.id, status: 'applied' };
        } catch (err) {
          return { id: op.id, status: 'error', error: String(err.message || err) };
        }
      });
      var live = null;
      if (body.live) {
        var current = readLive_();
        live = Live.applyPush(current, body.live, new Date().toISOString());
        if (live !== current) writeLive_(live);
      }
      return { results: results, live: live };
    } finally {
      lock.releaseLock();
    }
  });
}

/** Run once from the script editor after deploying to a new copy of the sheet, to grant access. */
function authorize() {
  SpreadsheetApp.getActiveSpreadsheet().getName();
  PropertiesService.getScriptProperties().getProperties();
}

// ---------- plumbing ----------

function respond_(fn) {
  var out;
  try {
    out = { ok: true, data: fn() };
  } catch (err) {
    out = { ok: false, error: String(err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function auth_(token) {
  // API_TOKEN is defined in secret.js, generated locally and never committed.
  var expected = typeof API_TOKEN === 'string' ? API_TOKEN : '';
  if (!expected) throw new Error('API_TOKEN not set; push secret.js');
  if (token !== expected) throw new Error('bad token');
}

function cycleNumber_(name) {
  var m = /^cycle(\d+)$/.exec(name);
  return m ? Number(m[1]) : -1;
}

function cycleNames_(ss) {
  return ss.getSheets().map(function (s) { return s.getName(); })
    .filter(function (n) { return cycleNumber_(n) > 0; })
    .sort(function (a, b) { return cycleNumber_(b) - cycleNumber_(a); });
}

function newestCycle_(ss) {
  return cycleNames_(ss)[0];
}

/** readCycle_ that reads each tab at most once. */
function cycleReader_(ss) {
  var seen = {};
  return function (name) { return seen[name] || (seen[name] = readCycle_(ss, name)); };
}

/**
 * The cycle being trained: the one asked for, else the one of the workout in
 * progress, else the newest cycle with anything logged (or the tab after it,
 * once it is finished). A tab set up ahead of time waits until the one before
 * it is done.
 */
function currentCycle_(ss, requested, read) {
  var names = cycleNames_(ss);
  var live = readLive_().session;
  var started = PropertiesService.getScriptProperties().getProperty(CURRENT_KEY);
  var wanted = [requested, live && live.cycle, started === names[0] ? started : null];
  for (var i = 0; i < wanted.length; i++) {
    if (wanted[i] && names.indexOf(wanted[i]) >= 0) return read(wanted[i]);
  }
  for (var j = 0; j < names.length && cycleNumber_(names[j]) >= MIN_WRITABLE_CYCLE; j++) {
    var c = read(names[j]);
    if (!cycleStarted_(c)) continue;
    return cycleFinished_(c) && j > 0 ? read(names[j - 1]) : c;
  }
  return read(names[0]);
}

function cycleSets_(c) {
  var sets = [];
  c.weeks.forEach(function (w) {
    w.days.forEach(function (d) { d.lifts.forEach(function (l) { sets = sets.concat(l.sets); }); });
  });
  return sets;
}

function cycleStarted_(c) {
  return cycleSets_(c).some(function (s) {
    return s.actual != null || s.done === true || (Array.isArray(s.done) && s.done.indexOf(true) >= 0);
  });
}

/** Every AMRAP logged: the same test the app uses to pick the next day. */
function cycleFinished_(c) {
  var amraps = cycleSets_(c).filter(function (s) { return s.kind === 'amrap'; });
  return amraps.length > 0 && amraps.every(function (s) { return s.actual != null; });
}

function colLetter_(col) {
  var s = '';
  while (col > 0) { var m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = (col - m - 1) / 26; }
  return s;
}

function isoDate_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/.exec(String(v));
  if (!m) return null;
  return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
}

// ---------- cycle tab ----------

// Rows/cols are 1-indexed sheet coordinates. Lift 1 has a header row under its
// name, lift 2 does not, so its sets start right below the name.
function liftNameRow_(week, lift) {
  return WEEK_ROWS[week - 1] + (lift === 1 ? 1 : 10);
}

function firstSetRow_(week, lift) {
  return WEEK_ROWS[week - 1] + (lift === 1 ? 3 : 11);
}

function layoutProblems_(v, f) {
  var problems = [];
  WEEK_ROWS.forEach(function (w, wi) {
    DAY_COLS.forEach(function (c, di) {
      var where = 'week ' + (wi + 1) + ' day ' + (di + 1) + ': ';
      if (String(v[w + 1][c]).toLowerCase() !== 'weight') problems.push(where + 'no "Weight" header at ' + colLetter_(c + 1) + (w + 2));
      [1, 2].forEach(function (lift) {
        var nameRow = liftNameRow_(wi + 1, lift);
        if (!v[nameRow - 1][c - 1]) problems.push(where + 'no lift name at ' + colLetter_(c) + nameRow);
        for (var i = 3; i < 7; i++) {
          var r = firstSetRow_(wi + 1, lift) + i;
          if (!/MROUND\(.*\$[C-G]\$2/i.test(f[r - 1][c])) problems.push(where + 'no TM formula at ' + colLetter_(c + 1) + r);
        }
      });
      if (String(v[w + 18][c + 1]).toLowerCase() !== 'weight') problems.push(where + 'no assistance header at ' + colLetter_(c + 2) + (w + 19));
    });
  });
  return problems;
}

function readCycle_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('no sheet ' + name);
  var range = sheet.getRange(1, 1, BLOCK_ROWS, BLOCK_COLS);
  var v = range.getValues();
  var f = range.getFormulas();
  var notes = range.getNotes();
  var cell = function (r, c) { return v[r - 1][c - 1]; };
  var note = function (r, c) { return notes[r - 1][c - 1] || null; };

  var tm = {};
  Object.keys(TM_COLS).forEach(function (col) {
    var x = cell(2, col.charCodeAt(0) - 64); // already in the grid: no extra sheet call
    if (typeof x === 'number') tm[TM_COLS[col]] = x;
  });

  var problems = layoutProblems_(v, f);
  var result = {
    name: name,
    number: cycleNumber_(name),
    tm: tm,
    writable: cycleNumber_(name) >= MIN_WRITABLE_CYCLE && problems.length === 0,
    layoutProblems: problems,
    bodyweight: typeof cell(6, 50) === 'number' ? cell(6, 50) : null, // AX6
    standards: readStandards_(v),
    weeks: []
  };
  if (problems.length) return result;

  WEEK_ROWS.forEach(function (w, wi) {
    var days = DAY_COLS.map(function (c, di) {
      var lifts = [1, 2].map(function (lift) {
        var r0 = firstSetRow_(wi + 1, lift);
        var tmMatch = /\$([C-G])\$2/.exec(f[r0 + 3 - 1][c + 1 - 1] || '');
        var sets = [];
        for (var i = 0; i < 7; i++) {
          var r = r0 + i;
          var kind = SET_KINDS[i];
          var s = {
            index: i,
            kind: kind,
            cell: colLetter_(c + 5) + r,
            pct: typeof cell(r, c) === 'number' ? cell(r, c) : null,
            weight: cell(r, c + 1),
            sets: cell(r, c + 3),
            reps: String(cell(r, c + 4)),
            note: note(r, c + 5)
          };
          if (kind === 'amrap') {
            s.actual = typeof cell(r, c + 5) === 'number' ? cell(r, c + 5) : null;
          } else if (kind === 'supplemental') {
            s.done = [0, 1, 2, 3, 4].map(function (k) { return cell(r, c + 5 + k) === true; });
          } else {
            s.done = cell(r, c + 5) === true;
          }
          sets.push(s);
        }
        return {
          name: cell(liftNameRow_(wi + 1, lift), c),
          key: tmMatch ? TM_COLS[tmMatch[1]] : null,
          sets: sets
        };
      });
      var hr = WEEK_ROWS[wi] + 19;
      var assistance = [];
      for (var a = 0; a < 4; a++) {
        var r = hr + 1 + a;
        if (!cell(r, c)) continue;
        var roundReps = [0, 1, 2, 3, 4].map(function (k) {
          var x = cell(r, c + 5 + k);
          return x === '' || typeof x === 'boolean' ? null : x;
        });
        assistance.push({
          index: a,
          name: cell(r, c),
          weight: cell(r, c + 2) === '' ? null : cell(r, c + 2),
          sets: cell(r, c + 3),
          reps: cell(r, c + 4) === '' ? null : cell(r, c + 4),
          // What rounds got when it wasn't the plan, typed into the round cells (e.g. 4, 4 in rounds 4-5).
          roundReps: roundReps.some(function (x) { return x !== null; }) ? roundReps : null,
          note: cell(r, c + 10) || note(r, c) || null
        });
      }
      return {
        day: di + 1,
        lifts: lifts,
        assistance: assistance,
        rounds: [0, 1, 2, 3, 4].map(function (k) { return cell(hr, c + 5 + k) === true; }),
        assistanceNote: cell(hr, c + 10) || null
      };
    });
    result.weeks.push({ week: wi + 1, days: days });
  });
  return result;
}

/**
 * Strength standards block (AW6:BE12): a header row naming the levels
 * (intermediate/advanced/elite, with 2y/5y/10y above), then one row per exercise
 * with its bodyweight ratio (or reps, for "pullup bw") at each level.
 */
function readStandards_(v) {
  var at = function (r, c) { return (v[r - 1] || [])[c - 1]; };
  var levels = [];
  for (var c = 50; c <= BLOCK_COLS; c++) {
    var h = String(at(7, c) || '').toLowerCase();
    if (/^(intermediate|advanced|elite)$/.test(h)) levels.push({ name: h, col: c, horizon: String(at(6, c) || '') || null });
  }
  if (!levels.length) return null;
  var rows = [];
  for (var r = 8; r <= 12; r++) {
    var name = String(at(r, 49) || '').trim();
    var targets = levels.map(function (l) { return at(r, l.col); });
    if (name && targets.every(function (x) { return typeof x === 'number' && x > 0; })) rows.push({ name: name, targets: targets });
  }
  return {
    levels: levels.map(function (l) { return { name: l.name, horizon: l.horizon }; }),
    rows: rows
  };
}

// ---------- archive ----------

function readArchive_(ss) {
  var cycles = cycleNames_(ss)
    .filter(function (n) { return cycleNumber_(n) >= MIN_WRITABLE_CYCLE; })
    .map(function (n) { return readCycle_(ss, n); });
  return { cycles: cycles, assistancePlan: readAssistancePlan_(ss) };
}

/** The "final:" list in "assistance plan": exercise name and its target range ("8-12", "30s per side"). */
function readAssistancePlan_(ss) {
  var sheet = ss.getSheetByName(PLAN_SHEET);
  if (!sheet || sheet.getLastRow() < 1) return [];
  var rows = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
  var out = [];
  var on = false;
  rows.forEach(function (r) {
    var name = String(r[0]).trim();
    if (/^final:?$/i.test(name)) { on = true; return; }
    if (on && name && r[1] !== '') out.push({ name: name, range: String(r[1]).trim() });
  });
  return out;
}

// ---------- history ----------

function readHistory_(ss) {
  var tz = ss.getSpreadsheetTimeZone();

  var rm = ss.getSheetByName('rm calc');
  var last = rm.getLastRow();
  var rows = rm.getRange(3, 1, Math.max(last - 2, 1), RM_DATE_COL).getValues();
  var sessions = [];
  rows.forEach(function (row, i) {
    var date = isoDate_(row[RM_DATE_COL - 1], tz);
    if (!date) return;
    var lifts = {};
    RM_LIFTS.forEach(function (l) {
      var w = row[l[1] - 1], reps = row[l[1]];
      if (typeof w === 'number' && typeof reps === 'number') lifts[l[0]] = { weight: w, reps: reps };
    });
    sessions.push({ row: i + 3, date: date, lifts: lifts });
  });

  var tms = cycleNames_(ss).map(function (name) {
    var sheet = ss.getSheetByName(name);
    var top = sheet.getRange(1, 1, 6, 50).getValues();
    var tmRow = top[1][1] === 'TM' ? 1 : top[2][1] === 'TM' ? 2 : -1;
    var tm = {};
    if (tmRow >= 0) {
      ['C', 'D', 'E', 'F', 'G'].forEach(function (col, k) {
        var x = top[tmRow][k + 2];
        if (typeof x === 'number') tm[TM_COLS[col]] = x;
      });
    }
    var bw = top[5][49];
    return { cycle: name, number: cycleNumber_(name), tm: tm, bodyweight: typeof bw === 'number' ? bw : null };
  });

  var log = ss.getSheetByName(LOG_SHEET);
  var entries = [];
  if (log && log.getLastRow() > 1) {
    log.getRange(2, 1, log.getLastRow() - 1, LOG_HEADERS.length).getValues().forEach(function (r) {
      var e = {};
      // Local time, no zone shift: "session date" 2026-09-28 must not come back as the 27th.
      LOG_HEADERS.forEach(function (h, k) { e[h] = r[k] instanceof Date ? Utilities.formatDate(r[k], tz, "yyyy-MM-dd'T'HH:mm:ss") : r[k]; });
      entries.push(e);
    });
  }

  return { sessions: sessions, trainingMaxes: tms, log: entries };
}

// ---------- writes ----------

function writableSheet_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('no sheet ' + name);
  if (cycleNumber_(name) < MIN_WRITABLE_CYCLE) throw new Error(name + ' uses the old layout; writes refused');
  var range = sheet.getRange(1, 1, BLOCK_ROWS, BLOCK_COLS);
  var problems = layoutProblems_(range.getValues(), range.getFormulas());
  if (problems.length) throw new Error('layout check failed: ' + problems[0]);
  return sheet;
}

function checkRange_(x, lo, hi, what) {
  if (typeof x !== 'number' || x < lo || x > hi || Math.floor(x) !== x) throw new Error('bad ' + what + ': ' + x);
}

function setAppNote_(range, text) {
  var existing = range.getNote();
  if (text) range.setNote(NOTE_PREFIX + text);
  else if (existing.indexOf(NOTE_PREFIX) === 0) range.setNote('');
}

function deviationNote_(op) {
  if (op.status === 'skipped') return 'skipped' + (op.note ? ': ' + op.note : '');
  if (op.status === 'changed') {
    var did = (op.actualWeight != null ? op.actualWeight + ' kg' : '') +
      (op.actualReps != null ? ' x ' + op.actualReps : '');
    return 'changed to ' + did.trim() + (op.note ? ': ' + op.note : '');
  }
  return op.note || '';
}

function applyOp_(ss, op) {
  switch (op.type) {
    case 'set': return applySet_(ss, op);
    case 'assist': return applyAssist_(ss, op);
    case 'assist_round': return applyRound_(ss, op);
    case 'rm': return applyRm_(ss, op);
    case 'extra': return; // only goes to the session log
    case 'hr': return applyHr_(ss, op);
    case 'bodyweight': return applyBodyweight_(ss, op);
    case 'new_cycle': return applyNewCycle_(ss, op);
    default: throw new Error('unknown op type ' + op.type);
  }
}

// op: {cycle, week, day, lift: 1|2, set: 0..6, sub: 0..4 (supplemental only),
//      status: done|changed|skipped|undo, actualWeight, actualReps, note}
function applySet_(ss, op) {
  var sheet = writableSheet_(ss, op.cycle);
  checkRange_(op.week, 1, 3, 'week'); checkRange_(op.day, 1, 4, 'day');
  checkRange_(op.lift, 1, 2, 'lift'); checkRange_(op.set, 0, 6, 'set');
  var c = DAY_COLS[op.day - 1];
  var r = firstSetRow_(op.week, op.lift) + op.set;
  var kind = SET_KINDS[op.set];
  var sub = 0;
  if (kind === 'supplemental') { checkRange_(op.sub || 0, 0, 4, 'sub'); sub = op.sub || 0; }
  var target = sheet.getRange(r, c + 5 + sub);

  if (kind === 'amrap') {
    if (op.status === 'skipped' || op.status === 'undo') target.clearContent();
    else {
      if (typeof op.actualReps !== 'number') throw new Error('AMRAP needs actualReps');
      target.setValue(op.actualReps);
    }
  } else {
    target.setValue(op.status === 'done' || op.status === 'changed');
  }
  setAppNote_(target, op.status === 'undo' ? '' : deviationNote_(op));
}

// op: {cycle, week, day, index: 0..3, name?, weight?, reps?, status, note}
function applyAssist_(ss, op) {
  var sheet = writableSheet_(ss, op.cycle);
  checkRange_(op.week, 1, 3, 'week'); checkRange_(op.day, 1, 4, 'day'); checkRange_(op.index, 0, 3, 'index');
  var c = DAY_COLS[op.day - 1];
  var r = WEEK_ROWS[op.week - 1] + 20 + op.index;
  if (op.name) sheet.getRange(r, c).setValue(op.name);
  if (op.actualWeight !== undefined) sheet.getRange(r, c + 2).setValue(op.actualWeight === null ? '' : op.actualWeight);
  if (op.actualReps !== undefined) sheet.getRange(r, c + 4).setValue(op.actualReps === null ? '' : op.actualReps);
  setAppNote_(sheet.getRange(r, c), op.status === 'undo' ? '' : deviationNote_(op));
}

// op: {cycle, week, day, index: 0..4, done: bool}
function applyRound_(ss, op) {
  var sheet = writableSheet_(ss, op.cycle);
  checkRange_(op.week, 1, 3, 'week'); checkRange_(op.day, 1, 4, 'day'); checkRange_(op.index, 0, 4, 'index');
  sheet.getRange(WEEK_ROWS[op.week - 1] + 19, DAY_COLS[op.day - 1] + 5 + op.index).setValue(!!op.done);
}

// op: {sessionDate: 'yyyy-mm-dd', lifts: {squat: {weight, reps}, ...}}
// Appends one row; dates are written as text "d.m.yyyy" like the recent rows.
function applyRm_(ss, op) {
  var sheet = ss.getSheetByName('rm calc');
  var dates = sheet.getRange(3, RM_DATE_COL, sheet.getLastRow() - 2, 1).getValues();
  var r = 3;
  for (var i = dates.length - 1; i >= 0; i--) {
    if (dates[i][0] !== '') { r = i + 4; break; }
  }
  var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(op.sessionDate || '');
  if (!d) throw new Error('bad sessionDate ' + op.sessionDate);
  RM_LIFTS.forEach(function (l) {
    var x = op.lifts && op.lifts[l[0]];
    if (!x) return;
    sheet.getRange(r, l[1], 1, 2).setValues([[x.weight, x.reps]]);
  });
  sheet.getRange(r, RM_DATE_COL).setNumberFormat('@')
    .setValue(Number(d[3]) + '.' + Number(d[2]) + '.' + d[1]);
}

// op: {sessionDate, startedAt, samples: [[unix secs, bpm], ...]}
// Heart rate from the watch, thinned to one sample every few seconds.
function applyHr_(ss, op) {
  var sheet = ss.getSheetByName(HR_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(HR_SHEET, ss.getSheets().length);
    sheet.getRange(1, 1, 1, HR_HEADERS.length).setValues([HR_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  var samples = op.samples || [];
  if (!samples.length) return;
  var start = Date.parse(op.startedAt) / 1000;
  var rows = samples.map(function (x) {
    checkRange_(x[1], 20, 250, 'bpm');
    return [op.sessionDate || '', op.startedAt || '', new Date(x[0] * 1000), isNaN(start) ? '' : Math.round(x[0] - start), x[1]];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HR_HEADERS.length).setValues(rows);
}

// op: {cycle, actualWeight}: bodyweight in kg, into AX6 of that cycle tab (the
// standards block divides by it). The session log row is the history.
function applyBodyweight_(ss, op) {
  var sheet = ss.getSheetByName(op.cycle);
  if (!sheet) throw new Error('no sheet ' + op.cycle);
  var w = op.actualWeight;
  if (typeof w !== 'number' || w < 30 || w > 250) throw new Error('bad bodyweight: ' + w);
  var cell = sheet.getRange(BW_CELL);
  if (cell.getFormula && cell.getFormula()) throw new Error(BW_CELL + ' is a formula in ' + op.cycle);
  cell.setValue(w);
}

// op: {name: 'cycle16', from: 'cycle15', tm: {squat: 100, ...}, bodyweight?}
// Copies the tab, puts it first and clears everything logged in it: AMRAPs,
// checkboxes, per-round reps, notes, and assistance weight/reps (planned per
// workout). Formulas, lift and exercise names, sets and warm-ups stay.
function applyNewCycle_(ss, op) {
  if (cycleNumber_(op.name) !== cycleNumber_(op.from) + 1) throw new Error('new cycle must follow ' + op.from);
  if (ss.getSheetByName(op.name)) throw new Error(op.name + ' already exists');
  var src = writableSheet_(ss, op.from);
  var sheet = ss.insertSheet(op.name, 0, { template: src });
  Object.keys(TM_COLS).forEach(function (col) {
    var x = op.tm && op.tm[TM_COLS[col]];
    if (x == null) return;
    if (typeof x !== 'number' || x <= 0 || x > 500) throw new Error('bad TM for ' + TM_COLS[col] + ': ' + x);
    sheet.getRange(col + '2').setValue(x);
  });
  if (typeof op.bodyweight === 'number') sheet.getRange(BW_CELL).setValue(op.bodyweight);
  WEEK_ROWS.forEach(function (w) {
    DAY_COLS.forEach(function (c) {
      // Sets, rounds and assistance rows: "actual" column and the 5 after it.
      clearKeepingFormulas_(sheet.getRange(w + 3, c + 5, 21, 6));
      // Assistance weight and reps; the sets column in between stays.
      [2, 4].forEach(function (k) { clearKeepingFormulas_(sheet.getRange(w + 20, c + k, 4, 1)); });
    });
  });
  PropertiesService.getScriptProperties().setProperty(CURRENT_KEY, op.name);
}

/** Checkboxes to FALSE, other values to empty, notes gone; formula cells untouched. One read, one write. */
function clearKeepingFormulas_(range) {
  var values = range.getValues();
  var formulas = range.getFormulas();
  range.setValues(values.map(function (row, i) {
    return row.map(function (x, j) {
      if (formulas[i][j]) return formulas[i][j];
      return typeof x === 'boolean' ? false : '';
    });
  }));
  range.clearNote();
}

// ---------- live session ----------

function readLive_() {
  var props = PropertiesService.getScriptProperties();
  var n = Number(props.getProperty(LIVE_KEY + ':n') || 0);
  if (!n) return Live.EMPTY_LIVE;
  var s = '';
  for (var i = 0; i < n; i++) s += props.getProperty(LIVE_KEY + ':' + i) || '';
  try { return JSON.parse(s); } catch (err) { return Live.EMPTY_LIVE; }
}

function writeLive_(doc) {
  var s = JSON.stringify(doc);
  var values = {};
  var n = Math.max(1, Math.ceil(s.length / LIVE_CHUNK));
  for (var i = 0; i < n; i++) values[LIVE_KEY + ':' + i] = s.slice(i * LIVE_CHUNK, (i + 1) * LIVE_CHUNK);
  values[LIVE_KEY + ':n'] = String(n);
  PropertiesService.getScriptProperties().setProperties(values);
}

// ---------- session log ----------

function logSheet_(ss) {
  var sheet = ss.getSheetByName(LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET, ss.getSheets().length);
    sheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < LOG_HEADERS.length) {
    // Older log without the timing columns: extend the header in place.
    sheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
  }
  return sheet;
}

function seenOpIds_(log) {
  var seen = {};
  if (log.getLastRow() > 1) {
    log.getRange(2, 1, log.getLastRow() - 1, 1).getValues().forEach(function (r) { seen[r[0]] = true; });
  }
  return seen;
}

function appendLog_(log, op) {
  var planned = op.planned || {};
  var slot = op.slot || (op.type === 'set' ? 'lift' + op.lift : op.type === 'rm' ? 'rm calc' : op.type);
  var hr = op.hr || {};
  var num = function (x) { return typeof x === 'number' ? x : ''; };
  var setLabel = op.type === 'set'
    ? (op.set + (SET_KINDS[op.set] === 'supplemental' ? '.' + (op.sub || 0) : ''))
    : (op.index != null ? op.index : '');
  log.appendRow([
    op.id, new Date(), op.sessionDate || '', op.cycle || '', op.week || '', op.day || '', slot,
    op.exercise || op.name || (op.type === 'rm' ? JSON.stringify(op.lifts) : op.type === 'hr' ? 'heart rate' : ''),
    op.kind || (op.type === 'set' ? SET_KINDS[op.set] : op.type), setLabel,
    planned.weight != null ? planned.weight : '', planned.reps != null ? planned.reps : '',
    op.actualWeight != null ? op.actualWeight : '', op.actualReps != null ? op.actualReps : '',
    op.status || (op.type === 'assist_round' ? (op.done ? 'done' : 'undo') : ''),
    op.note || (op.type === 'hr' ? (op.samples || []).length + ' samples' : ''),
    // Client-side times: "logged at" is when the phone got signal, this is when it happened.
    op.doneAt ? new Date(op.doneAt) : '', op.secsSincePrevious != null ? op.secsSincePrevious : '',
    op.secsSinceStart != null ? op.secsSinceStart : '',
    num(hr.done), num(hr.peak), num(hr.low), num(hr.avg)
  ]);
}
