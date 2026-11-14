// In-memory run of a full day through the backend: tasks, split time, progress, questions, approval and mails.
// Usage: node tests/test_flow.js dist/Code.gs
const fs = require('fs'), vm = require('vm');

function calc(x, i) {
  const v = x[i];
  if (i !== 6 || typeof v !== 'string' || !v.startsWith('=IF')) return v;
  if (!(x[2] instanceof Date) || !(x[3] instanceof Date)) return '';
  return Math.round(((x[3] - x[2]) / 3600000 - (Number(x[5]) || 0) / 60) * 100) / 100;
}
const show = v => v == null ? '' : v instanceof Date ? v.toISOString().slice(11, 16) : String(v);
function tab(rows) {
  return {
    rows,
    getLastRow() { return rows.length; },
    insertRowBefore(r) { rows.splice(r - 1, 0, []); },
    appendRow(v) { rows.push(v); },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValue() { return (rows[r - 1] || [])[c - 1]; },
        getDisplayValue() { return show((rows[r - 1] || [])[c - 1]); },
        getValues() { return rows.slice(r - 1, r - 1 + nr).map(x => { const o = []; for (let i = 0; i < nc; i++) o.push(calc(x, c - 1 + i)); return o; }); },
        getDisplayValues() { return this.getValues().map(x => x.map(show)); },
        setValues(v) { v.forEach((x, i) => x.forEach((y, j) => { (rows[r - 1 + i] = rows[r - 1 + i] || [])[c - 1 + j] = y; })); return this; },
        setValue(v) { (rows[r - 1] = rows[r - 1] || [])[c - 1] = v; return this; },
        setFormula(v) { return this.setValue(v); },
        setNumberFormat() { return this; }, setFontWeight() { return this; },
      };
    },
  };
}
const mails = [], gmail = [], props = {};
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const ctx = { console, Math, Date, JSON, Array, Object, Number, String, isNaN,
  SpreadsheetApp: { flush() {} }, MailApp: { sendEmail: m => mails.push(m) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  Gmail: { Users: { Messages: {
    send(r) { const raw = Buffer.from(r.raw, 'base64url').toString('utf8'); const n = gmail.length;
      gmail.push({ raw, threadId: r.threadId, body: Buffer.from(raw.split('\r\n\r\n')[1], 'base64').toString('utf8') });
      return { id: 'm' + n, threadId: r.threadId || 't' + n }; },
    get: (u, id) => ({ payload: { headers: [{ name: 'Message-Id', value: '<' + id + '@mail>' }] } }) } } },
  Utilities: { Charset: { UTF_8: 'utf8' }, base64Encode: s => b64(s), base64EncodeWebSafe: s => Buffer.from(s, 'utf8').toString('base64url'),
    parseDate: s => new Date(s + 'T00:00:00Z'),
    formatDate: (d, z, f) => f === 'u' ? String(d.getUTCDay() || 7) : f === 'HH:mm' ? d.toISOString().slice(11, 16)
      : f === 'dd/MM/yyyy' ? d.toISOString().slice(0, 10).split('-').reverse().join('/') : d.toISOString().slice(0, 10) } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx);

const sheets = {
  'שעות': tab([['h']]), 'יומן לחיצות': tab([['ts', 'act', 'note']]), 'משימות': tab([['h']]),
  'קטעי עבודה': tab([['h']]), 'הערות משימות': tab([['h']]),
};
const ss = { getSheetByName: n => sheets[n] };
const t = m => new Date(Date.UTC(2026, 10, 15, 7, m)); // Sunday 15/11/2026 07:00 UTC
let failed = 0;
function ok(c, m) { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) failed++; }
const snir = (p, m) => ctx.apply_(ss, p, t(m));
const boss = (p, m) => ctx.manage_(ss, p, t(m));
const view = m => ctx.payload_(ss, t(m), 'manager', true);
const task = (id, m) => view(m).tasks.find(x => x.id === id);
const sessions = () => sheets['קטעי עבודה'].rows.slice(1);

// Shafrir adds two tasks; Snir gets a mail for each.
boss({ action: 'task_add', task: { title: 'אפיון מערכת', desc: 'מסמך אפיון', est: 4, deadline: '2026-11-20' } }, -10);
boss({ action: 'task_add', task: { title: 'חשבונות טוויטר', est: '' } }, -9);
ok(boss({ action: 'task_add', task: { title: '  ' } }, -8).error === 'empty', 'empty title refused');
ok(boss({ action: 'task_add', task: { title: 'x', deadline: '20/11' } }, -8).error === 'bad_deadline', 'bad deadline refused');
ok(sheets['משימות'].rows.length === 3 && sheets['משימות'].rows[1][0] === 'T1' && sheets['משימות'].rows[2][0] === 'T2', 'tasks T1, T2 in sheet');
ok(mails.length === 2 && mails[0].subject.includes('משימה חדשה 1') && mails[0].subject.includes('אפיון מערכת'), 'Snir mailed on new task, numbered');

// 07:00 start on both tasks; 08:00 break: each got half of the hour.
snir({ action: 'start', tasks: ['T1', 'T2'] }, 0);
ok(task('T1', 0).status === 'בעבודה', 'task moves to in progress on start');
snir({ action: 'break_start', note: 'אוכל', reports: [{ id: 'T1', note: 'כתבתי פרק 1', pct: 30 }, { id: 'T2', pct: 10 }] }, 60);
ok(sessions().length === 2 && sessions()[0][5] === 30 && sessions()[1][5] === 30, 'hour split 30/30 between two tasks');
ok(sessions()[0][7] === 0 && sessions()[0][8] === 30 && sessions()[0][9] === 'כתבתי פרק 1', 'session keeps from/to percent and note');
ok(view(60).resume.join() === 'T1,T2', 'break remembers tasks to resume');

// 08:30 back on T1 only; 09:00 T2 joins; 10:00 T2 done at 100%.
snir({ action: 'break_end', tasks: ['T1'] }, 90);
snir({ action: 'task_on', id: 'T2' }, 120);
ok(Math.abs(task('T1', 150).active.minutes - 45) < 0.01, 'live minutes: 30 alone + 15 shared');
snir({ action: 'task_off', id: 'T2', note: 'פתחתי 3 חשבונות', pct: 100 }, 180);
ok(task('T2', 180).status === 'הושלם', '100% means done, no approval wait');
ok(gmail.length === 1 && gmail[0].body.includes('משימה 2 "חשבונות טוויטר" הושלמה'), 'Shafrir mailed that task 2 is done');

// 10:20 Snir is stuck on T1: its stretch closes and Shafrir gets the question in the same day thread.
snir({ action: 'block', id: 'T1', text: 'איזה פורמט למסמך?' }, 200);
const t1 = task('T1', 200);
ok(t1.status === 'תקוע' && t1.question === 'איזה פורמט למסמך?' && !t1.active, 'stuck closes the stretch and stores the question');
ok(Math.abs(t1.minutes - 110) < 0.01, 'T1 total 30 + 30 + 30 + 20 = 110 minutes');
ok(gmail.length === 2 && gmail[1].threadId === 't0' && /In-Reply-To: <m0@mail>/.test(gmail[1].raw), 'question replies in the day thread');

// Shafrir answers, approves T2, reorders.
boss({ action: 'answer', id: 'T1', text: 'Google Docs' }, 205);
ok(task('T1', 205).status === 'בעבודה' && task('T1', 205).question === '', 'answer unblocks');
ok(boss({ action: 'approve', id: 'T1' }, 206).error === 'invalid_state', 'cannot approve a task not waiting');
ok(boss({ action: 'approve', id: 'T2' }, 206).error === 'invalid_state', 'nothing waits for approval any more');
ok(snir({ action: 'task_on', id: 'T2' }, 207).error === 'task_closed', 'done task cannot be opened');
boss({ action: 'reorder', order: ['T2', 'T1'] }, 207);
ok(task('T1', 207).order === 2 && task('T2', 207).order === 1, 'reorder saved');
ok(task('T1', 207).comments.map(c => c.who).join() === 'שניר,שפריר', 'comments from both sides');

// 10:30 back on T1, 11:00 end with 60%.
snir({ action: 'task_on', id: 'T1' }, 210);
snir({ action: 'end', reports: [{ id: 'T1', note: 'סיימתי טיוטה', pct: 60 }] }, 240);
const end = view(240);
ok(end.state === 'off' && !end.tasks.some(x => x.active), 'day closed, nothing active');
ok(task('T1', 240).pct === 60 && Math.abs(task('T1', 240).minutes - 140) < 0.01, 'T1 at 60% after 140 minutes');
const summary = gmail[gmail.length - 1].body;
ok(summary.includes('לפי משימות') && summary.includes('משימה 1, אפיון מערכת: 2.33 שעות, 0% עד 60%') && summary.includes('משימה 2, חשבונות טוויטר: 1.00 שעות, 0% עד 100%'), 'day summary per task');
ok(summary.includes('manager.html?m=' + ctx.CONFIG.MANAGER_KEY), 'summary links the board');
ok(mails.some(m => m.subject.startsWith('שפריר, סיכום יום')), 'Snir gets the day summary too');
const shiftHours = sheets['שעות'].rows[1];
ok(calc(shiftHours, 6) === 3.5, 'shift: 4 hours minus 30 minute break = 3.5');
ok(Math.abs(sessions().reduce((m, s) => m + s[5], 0) - 200) < 0.01, 'task minutes = shift 210 minus 10 minutes with no task open');
ok(sessions()[0][10] instanceof Date && sessions()[0][10].toISOString().startsWith('2026-11-15'), 'week column starts Sunday');

// Delete hides the task from both apps but keeps the row.
boss({ action: 'task_delete', id: 'T2' }, 250);
ok(!view(250).tasks.some(x => x.id === 'T2') && sheets['משימות'].rows[2][6] === 'נמחק', 'deleted task hidden, row kept');

console.log(failed ? failed + ' FAILED' : 'PASS');
process.exit(failed ? 1 : 0);
