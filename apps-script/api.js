// JSON API for the 5/3/1 PWA. Lives next to extractExerciseData() in the same
// Apps Script project; every helper here ends in "_" so nothing clashes.
//
// GET  ?token=..&action=ping|cycle|history|bootstrap[&name=cycle15]
// POST body (Content-Type: text/plain, avoids CORS preflight):
//      {"token": "..", "ops": [{"id": "..", "type": "set"|"assist"|"assist_round"|"rm"|"extra", ...}]}

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
  'actual reps', 'status', 'note', 'done at', 'secs since previous', 'secs since start'];
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
      case 'bootstrap': {
        var name = newestCycle_(ss);
        var prev = 'cycle' + (cycleNumber_(name) - 1);
        return {
          cycle: readCycle_(ss, name),
          previous: ss.getSheetByName(prev) ? readCycle_(ss, prev) : null,
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
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var log = logSheet_(ss);
      var seen = seenOpIds_(log);
      return {
        results: (body.ops || []).map(function (op) {
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
        })
      };
    } finally {
      lock.releaseLock();
    }
  });
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
    var x = sheet.getRange(col + '2').getValue();
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
        assistance.push({
          index: a,
          name: cell(r, c),
          weight: cell(r, c + 2) === '' ? null : cell(r, c + 2),
          sets: cell(r, c + 3),
          reps: cell(r, c + 4) === '' ? null : cell(r, c + 4)
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
    var top = sheet.getRange(1, 1, 3, 7).getValues();
    var tmRow = top[1][1] === 'TM' ? 1 : top[2][1] === 'TM' ? 2 : -1;
    var tm = {};
    if (tmRow >= 0) {
      ['C', 'D', 'E', 'F', 'G'].forEach(function (col, k) {
        var x = top[tmRow][k + 2];
        if (typeof x === 'number') tm[TM_COLS[col]] = x;
      });
    }
    return { cycle: name, number: cycleNumber_(name), tm: tm };
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
  var slot = op.type === 'set' ? 'lift' + op.lift : op.type === 'rm' ? 'rm calc' : op.type;
  var setLabel = op.type === 'set'
    ? (op.set + (SET_KINDS[op.set] === 'supplemental' ? '.' + (op.sub || 0) : ''))
    : (op.index != null ? op.index : '');
  log.appendRow([
    op.id, new Date(), op.sessionDate || '', op.cycle || '', op.week || '', op.day || '', slot,
    op.exercise || op.name || (op.type === 'rm' ? JSON.stringify(op.lifts) : ''),
    op.type === 'set' ? SET_KINDS[op.set] : op.type, setLabel,
    planned.weight != null ? planned.weight : '', planned.reps != null ? planned.reps : '',
    op.actualWeight != null ? op.actualWeight : '', op.actualReps != null ? op.actualReps : '',
    op.status || (op.type === 'assist_round' ? (op.done ? 'done' : 'undo') : ''), op.note || '',
    // Client-side times: "logged at" is when the phone got signal, this is when it happened.
    op.doneAt ? new Date(op.doneAt) : '', op.secsSincePrevious != null ? op.secsSincePrevious : '',
    op.secsSinceStart != null ? op.secsSinceStart : ''
  ]);
}
