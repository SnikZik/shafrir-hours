// Local preview: serves the site and runs dist/Code.gs in memory as the API, with an in-memory sheet.
// Usage: node tests/mock_server.js dist/Code.gs 8129   (keys are the real ones from the build)
const fs = require('fs'), vm = require('vm'), http = require('http'), path = require('path');
const root = path.join(__dirname, '..');
const show = v => v == null ? '' : v instanceof Date ? new Date(v.getTime() + 2 * 3600000).toISOString().slice(11, 16) : String(v);
function calc(x, i) {
  const v = x[i];
  if (i !== 6 || typeof v !== 'string' || !v.startsWith('=IF')) return v;
  if (!(x[2] instanceof Date) || !(x[3] instanceof Date)) return '';
  return Math.round(((x[3] - x[2]) / 3600000 - (Number(x[5]) || 0) / 60) * 100) / 100;
}
function tab(rows) {
  return { rows, getLastRow: () => rows.length, insertRowBefore(r) { rows.splice(r - 1, 0, []); }, appendRow(v) { rows.push(v); },
    getRange(r, c, nr = 1, nc = 1) { return {
      getValue: () => (rows[r - 1] || [])[c - 1], getDisplayValue: () => show((rows[r - 1] || [])[c - 1]),
      getValues: () => rows.slice(r - 1, r - 1 + nr).map(x => { const o = []; for (let i = 0; i < nc; i++) o.push(calc(x, c - 1 + i)); return o; }),
      getDisplayValues() { return this.getValues().map(x => x.map(show)); },
      setValues(v) { v.forEach((x, i) => x.forEach((y, j) => { (rows[r - 1 + i] = rows[r - 1 + i] || [])[c - 1 + j] = y; })); return this; },
      setValue(v) { (rows[r - 1] = rows[r - 1] || [])[c - 1] = v; return this; }, setFormula(v) { return this.setValue(v); },
      setNumberFormat() { return this; }, setFontWeight() { return this; } }; } };
}
const sheets = { 'שעות': tab([['h']]), 'יומן לחיצות': tab([['h']]), 'משימות': tab([['h']]), 'קטעי עבודה': tab([['h']]), 'הערות משימות': tab([['h']]) };
const props = {}, mails = [];
const tzFmt = (d, f) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  if (f === 'u') return String(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1);
  if (f === 'HH:mm') return p.hour + ':' + p.minute;
  if (f === 'dd/MM/yyyy') return p.day + '/' + p.month + '/' + p.year;
  return p.year + '-' + p.month + '-' + p.day;
};
const ctx = { console, Math, Date, JSON, Array, Object, Number, String, isNaN,
  SpreadsheetApp: { flush() {}, openById: () => ({ getSheetByName: n => sheets[n] }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  MailApp: { sendEmail: m => { mails.push(m); console.log('MAIL to Snir:', m.subject); } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  Gmail: { Users: { Messages: { send: r => { console.log('MAIL to Shafrir thread'); return { id: 'm', threadId: 't' }; }, get: () => ({ payload: { headers: [{ name: 'Message-ID', value: '<m>' }] } }) } } },
  ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
  Utilities: { Charset: { UTF_8: 'utf8' }, base64Encode: s => Buffer.from(s).toString('base64'), base64EncodeWebSafe: s => Buffer.from(s).toString('base64url'),
    parseDate: s => new Date(s + 'T00:00:00+02:00'), formatDate: (d, z, f) => tzFmt(d, f) } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), ctx);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const out = req.method === 'POST' ? ctx.doPost({ postData: { contents: body } }) : ctx.doGet({ parameter: Object.fromEntries(url.searchParams) });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out.s);
    });
    return;
  }
  if (url.pathname === '/config.js') { res.writeHead(200, { 'Content-Type': types['.js'] }); return res.end('window.HOURS_API = "/api";'); }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(Number(process.argv[3] || 8129), () => console.log('mock on', process.argv[3] || 8129));
