// A stand-in for the bits of Google Apps Script that apps-script/api.js uses
// (SpreadsheetApp, PropertiesService, ContentService, LockService, Utilities),
// so the real backend code runs unmodified in Node against an in-memory sheet.
// Formulas are kept as text but never recalculated: cells show whatever value
// they had when the workbook was loaded, which is all the app reads.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

function a1(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) throw new Error(`bad A1 reference ${ref}`);
  const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  return { row: Number(m[2]), col };
}

export class Sheet {
  constructor(name, { values = [], formulas = {}, notes = {} } = {}) {
    this.name = name;
    this.values = values; // values[row - 1][col - 1], sparse
    this.formulas = formulas; // "row,col" -> "=..."
    this.notes = notes;
    this.formats = {};
  }

  getName() { return this.name; }

  get(r, c) {
    const v = this.values[r - 1]?.[c - 1];
    return v === undefined || v === null ? '' : v;
  }

  set(r, c, v) {
    // Like Apps Script, a string starting with "=" becomes a formula (its value isn't computed here).
    if (typeof v === 'string' && v.startsWith('=')) {
      (this.values[r - 1] ??= [])[c - 1] = this.get(r, c);
      this.formulas[`${r},${c}`] = v;
      return;
    }
    (this.values[r - 1] ??= [])[c - 1] = v;
    delete this.formulas[`${r},${c}`];
  }

  getLastRow() {
    for (let r = this.values.length; r > 0; r--) {
      if ((this.values[r - 1] ?? []).some((v) => v !== '' && v !== null && v !== undefined)) return r;
    }
    return 0;
  }

  getLastColumn() {
    let max = 0;
    for (const row of this.values) {
      if (!row) continue;
      for (let c = row.length; c > max; c--) {
        if (row[c - 1] !== '' && row[c - 1] !== null && row[c - 1] !== undefined) { max = c; break; }
      }
    }
    return max;
  }

  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const [from, to] = a.split(':').map(a1);
      const end = to ?? from;
      return new Range(this, from.row, from.col, end.row - from.row + 1, end.col - from.col + 1);
    }
    return new Range(this, a, b, c ?? 1, d ?? 1);
  }

  appendRow(row) {
    const r = this.getLastRow() + 1;
    row.forEach((v, i) => this.set(r, i + 1, v));
    return this;
  }

  setFrozenRows() { return this; }
}

class Range {
  constructor(sheet, row, col, rows, cols) {
    if (row < 1 || col < 1 || rows < 1 || cols < 1) throw new Error(`bad range ${row},${col} ${rows}x${cols}`);
    Object.assign(this, { sheet, row, col, rows, cols });
  }

  grid(fn) {
    return Array.from({ length: this.rows }, (_, i) => Array.from({ length: this.cols }, (_, j) => fn(this.row + i, this.col + j)));
  }

  each(fn) { this.grid(fn); return this; }

  getValues() { return this.grid((r, c) => this.sheet.get(r, c)); }
  getFormulas() { return this.grid((r, c) => this.sheet.formulas[`${r},${c}`] ?? ''); }
  getNotes() { return this.grid((r, c) => this.sheet.notes[`${r},${c}`] ?? ''); }
  getValue() { return this.sheet.get(this.row, this.col); }
  getNote() { return this.sheet.notes[`${this.row},${this.col}`] ?? ''; }
  getFormula() { return this.sheet.formulas[`${this.row},${this.col}`] ?? ''; }
  clearNote() { return this.setNote(''); }
  setValue(v) { return this.each((r, c) => this.sheet.set(r, c, v)); }
  setValues(rows) {
    if (rows.length !== this.rows || rows.some((x) => x.length !== this.cols)) throw new Error('setValues: size mismatch');
    return this.each((r, c) => this.sheet.set(r, c, rows[r - this.row][c - this.col]));
  }
  setNote(text) {
    return this.each((r, c) => {
      if (text) this.sheet.notes[`${r},${c}`] = text;
      else delete this.sheet.notes[`${r},${c}`];
    });
  }
  clearContent() { return this.each((r, c) => this.sheet.set(r, c, '')); }
  setNumberFormat(f) { return this.each((r, c) => { this.sheet.formats[`${r},${c}`] = f; }); }
  setFontWeight() { return this; }
}

export class Spreadsheet {
  constructor(sheets, tz = 'Europe/Prague') {
    this.sheets = sheets;
    this.tz = tz;
  }
  getSheets() { return [...this.sheets]; }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) ?? null; }
  insertSheet(name, index = this.sheets.length, opts = {}) {
    if (this.getSheetByName(name)) throw new Error(`sheet ${name} exists`);
    const t = opts.template;
    const s = t
      ? new Sheet(name, { values: t.values.map((row) => (row ? [...row] : [])), formulas: { ...t.formulas }, notes: { ...t.notes } })
      : new Sheet(name);
    this.sheets.splice(index, 0, s);
    return s;
  }
  getSpreadsheetTimeZone() { return this.tz; }
}

/** Utilities.formatDate for the patterns the backend uses (yyyy MM dd HH mm ss, quoted literals). */
function formatDate(date, tz, pattern) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss/g, (m, lit) => {
    if (lit !== undefined) return lit;
    return { yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute, ss: parts.second }[m];
  });
}

// ---------- JSON (de)serialisation of a workbook ----------

/** { sheets: [{ name, values, formulas, notes }], props }, dates as {"$date": iso}. */
export function toJSON(ss, props) {
  const enc = (v) => (isDate(v) ? { $date: v.toISOString() } : v);
  return {
    tz: ss.tz,
    sheets: ss.sheets.map((s) => ({
      name: s.name,
      values: s.values.map((row) => (row ? Array.from(row, enc) : [])),
      formulas: s.formulas,
      notes: s.notes,
    })),
    props,
  };
}

function fromJSON(data, DateCtor) {
  const dec = (v) => (v && typeof v === 'object' && '$date' in v ? new DateCtor(v.$date) : v);
  const sheets = data.sheets.map((s) => new Sheet(s.name, {
    values: s.values.map((row) => (row ? row.map(dec) : [])),
    formulas: { ...s.formulas },
    notes: { ...s.notes },
  }));
  return new Spreadsheet(sheets, data.tz);
}

// ---------- the runtime ----------

const BACKEND_FILES = ['live.js', 'api.js'];

/**
 * Loads apps-script/{live,api}.js into a fresh V8 context wired to a workbook.
 * Returns doGet/doPost that take the same event shapes Apps Script passes.
 */
export function createBackend(data, { token = 'dev', dir = new URL('../apps-script/', import.meta.url) } = {}) {
  const props = { ...(data.props ?? {}) };
  const ctx = vm.createContext({ console, API_TOKEN: token });
  // Dates must come from the context's own Date, or `instanceof Date` in api.js fails.
  const ss = fromJSON(data, vm.runInContext('Date', ctx));
  Object.assign(ctx, {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        setProperties: (o) => { for (const k of Object.keys(o)) props[k] = String(o[k]); },
        deleteProperty: (k) => { delete props[k]; },
        getProperties: () => ({ ...props }),
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; }, getContent() { return text; } }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate },
  });
  for (const f of BACKEND_FILES) {
    vm.runInContext(readFileSync(new URL(f, dir), 'utf8'), ctx, { filename: f });
  }
  const call = (fn, e) => JSON.parse(ctx[fn](e).getContent());
  return {
    ss,
    props,
    doGet: (params) => call('doGet', { parameter: params }),
    doPost: (body) => call('doPost', { postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }),
    toJSON: () => toJSON(ss, props),
  };
}
