// In-memory run of a full day through apply_: notes land on the shift row and in the end-of-day email.
const fs = require('fs'), vm = require('vm');
// Net-hours formula in column G evaluated the way Sheets would.
function calc(x, i) {
  const v = x[i];
  if (i !== 6 || typeof v !== 'string' || !v.startsWith('=IF')) return v;
  if (!(x[2] instanceof Date) || !(x[3] instanceof Date)) return '';
  return Math.round(((x[3] - x[2]) / 3600000 - (Number(x[5]) || 0) / 60) * 100) / 100;
}
function tab(rows) {
  return {
    rows,
    getLastRow() { return rows.length; },
    insertRowBefore(r) { rows.splice(r - 1, 0, []); },
    appendRow(v) { rows.push(v); },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValue() { return (rows[r - 1] || [])[c - 1]; },
        getDisplayValue() { const v = (rows[r - 1] || [])[c - 1]; return v == null ? '' : v instanceof Date ? v.toISOString().slice(11, 16) : String(v); },
        getValues() { return rows.slice(r - 1, r - 1 + nr).map(x => { const o = []; for (let i = 0; i < nc; i++) o.push(calc(x, c - 1 + i)); return o; }); },
        setValues(v) { v.forEach((x, i) => x.forEach((y, j) => { (rows[r - 1 + i] = rows[r - 1 + i] || [])[c - 1 + j] = y; })); return this; },
        setValue(v) { (rows[r - 1] = rows[r - 1] || [])[c - 1] = v; return this; },
        setFormula(v) { return this.setValue(v); },
        getDisplayValues() { return this.getValues().map(x => x.map(v => v == null ? '' : v instanceof Date ? v.toISOString().slice(11, 16) : String(v))); },
        setNumberFormat() { return this; }, setFontWeight() { return this; },
      };
    },
  };
}
const mails = [], gmail = [], props = {};
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const ctx = { console, Math, Date, JSON, SpreadsheetApp: { flush() {} }, MailApp: { sendEmail: m => mails.push(m) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  Gmail: { Users: { Messages: {
    send(r) { const raw = Buffer.from(r.raw, 'base64url').toString('utf8'); const n = gmail.length;
      gmail.push({ raw, threadId: r.threadId, body: Buffer.from(raw.split('\r\n\r\n')[1], 'base64').toString('utf8') });
      return { id: 'm' + n, threadId: r.threadId || 't' + n }; },
    get: (u, id) => ({ payload: { headers: [{ name: 'Message-Id', value: '<' + id + '@mail>' }] } }) } } },
  Utilities: { Charset: { UTF_8: 'utf8' }, base64Encode: s => b64(s), base64EncodeWebSafe: s => Buffer.from(s, 'utf8').toString('base64url'),
    formatDate: (d, z, f) => f === 'u' ? '1' : f === 'HH:mm' ? d.toISOString().slice(11, 16) : f === 'dd/MM/yyyy' ? '11/11/2026' : d.toISOString().slice(0, 10) } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx);
const hours = tab([['h']]), log = tab([['ts', 'act', 'note']]);
const ss = { getSheetByName: n => n === 'שעות' ? hours : log };
const t = m => new Date(Date.UTC(2026, 10, 11, 7, m));
function ok(c, m) { if (!c) { console.log('FAIL', m); process.exit(1); } console.log('ok', m); }
ctx.apply_(ss, 'start', t(0));
ctx.apply_(ss, 'break_start', t(60), '  סיימתי את הדוח ');
ctx.apply_(ss, 'break_end', t(90));
ctx.apply_(ss, 'end', t(240), 'פגישה עם הצוות');
const shift = hours.rows[1];
ok(shift[8] === '08:00 סיימתי את הדוח\n11:00 פגישה עם הצוות', 'notes on shift row, trimmed, with times');
ok(log.rows[2][2] === 'סיימתי את הדוח' && log.rows[3][2] === '' && log.rows[4][2] === 'פגישה עם הצוות', 'notes in log');
ok(hours.rows[2][1] === 'סה"כ', 'total row still under shift');
ok(mails.length === 1 && mails[0].to === ctx.CONFIG.REPORT_EMAILS, 'one report mail, no start/end manager mails');
ok(mails[0].body.includes('פגישה עם הצוות') && mails[0].body.includes('סיימתי את הדוח'), 'report has both notes');
console.log(mails[0].subject + '\n' + mails[0].body);
ok(gmail.length === 4, 'thread mail on every press');
ok(!gmail[0].threadId && !/In-Reply-To/.test(gmail[0].raw), 'first press opens a new thread');
ok(gmail.slice(1).every(m => m.threadId === 't0' && /In-Reply-To: <m0@mail>/.test(m.raw) && /References: <m0@mail>/.test(m.raw)), 'later presses reply in the same thread');
ok(gmail.every(m => m.raw.startsWith('To: ' + ctx.CONFIG.THREAD_EMAILS + '\r\n')), 'thread goes to THREAD_EMAILS');
ok(gmail[1].body.includes('יצאתי להפסקה בשעה 08:00') && gmail[1].body.includes('סיבה: סיימתי את הדוח'), 'break mail has reason');
ok(gmail[2].body.includes('חזרתי מהפסקה בשעה 08:30'), 'back mail');
ok(gmail[3].body.includes('סה"כ שעות עבודה 3.50') && gmail[3].body.includes('פגישה עם הצוות') && gmail[3].body.includes('href="https://docs.google.com/spreadsheets/d/' + ctx.CONFIG.SHEET_ID + '/edit"'), 'end mail has hours, notes, sheet link');
ctx.apply_(ss, 'start', t(300));
ctx.apply_(ss, 'end', t(330));
ok(mails.length === 2 && mails[1].body.includes('לא נרשם'), 'day without notes still reports');
ok(gmail.length === 6 && gmail[4].threadId === 't0', 'second shift same day stays in the thread');
console.log('PASS');
