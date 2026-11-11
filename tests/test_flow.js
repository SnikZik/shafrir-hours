// In-memory run of a full day through apply_: notes land on the shift row and in the end-of-day email.
const fs = require('fs'), vm = require('vm');
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
        getValues() { return rows.slice(r - 1, r - 1 + nr).map(x => { const o = []; for (let i = 0; i < nc; i++) o.push(x[c - 1 + i]); return o; }); },
        setValues(v) { v.forEach((x, i) => x.forEach((y, j) => { (rows[r - 1 + i] = rows[r - 1 + i] || [])[c - 1 + j] = y; })); return this; },
        setValue(v) { (rows[r - 1] = rows[r - 1] || [])[c - 1] = v; return this; },
        setFormula(v) { return this.setValue(v); },
        setNumberFormat() { return this; }, setFontWeight() { return this; },
      };
    },
  };
}
const mails = [];
const ctx = { console, Math, Date, SpreadsheetApp: { flush() {} }, MailApp: { sendEmail: m => mails.push(m) },
  Utilities: { formatDate: (d, z, f) => f === 'u' ? '1' : f === 'HH:mm' ? d.toISOString().slice(11, 16) : d.toISOString().slice(0, 10) } };
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
ctx.apply_(ss, 'start', t(300));
ctx.apply_(ss, 'end', t(330));
ok(mails.length === 2 && mails[1].body.includes('לא נרשם'), 'day without notes still reports');
console.log('PASS');
