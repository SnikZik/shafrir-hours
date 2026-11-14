// Work-hours and task backend (Snir at Shafrir). The Google Sheet is the database.
// Two keys: KEY is Snir's app, MANAGER_KEY is Shafrir's task board. build.py fills in the real values.
var CONFIG = {
  SHEET_ID: '__SHEET_ID__',
  KEY: '__KEY__',
  MANAGER_KEY: '__MANAGER_KEY__',
  EMPLOYEE: 'שניר',
  MANAGER: 'שפריר',
  TZ: 'Asia/Jerusalem',
  STALE_HOURS: 16, // an open shift older than this is treated as forgotten
  REMIND_EMAILS: '__REMIND_EMAILS__', // comma separated, mailed when nothing was pressed for REMIND_HOURS
  REMIND_HOURS: 3,
  REPORT_EMAILS: '__REPORT_EMAILS__', // Snir: day summary and every change Shafrir makes
  THREAD_EMAILS: '__THREAD_EMAILS__', // Shafrir: one thread per day, important events only
  APP_URL: 'https://snikzik.github.io/shafrir-hours/?k=',
  BOARD_URL: 'https://snikzik.github.io/shafrir-hours/manager.html?m='
};

var LOG_TAB = 'יומן לחיצות';
var HOURS_TAB = 'שעות';
var MONTHLY_TAB = 'סיכום חודשי';
var TASKS_TAB = 'משימות';
var SESSIONS_TAB = 'קטעי עבודה';
var COMMENTS_TAB = 'הערות משימות';
var WEEKLY_TAB = 'סיכום שבועי';
var TOTAL_LABEL = 'סה"כ';
var LABELS = {
  start: 'התחלתי לעבוד',
  break_start: 'יצאתי להפסקה',
  break_end: 'חזרתי מהפסקה',
  end: 'סיימתי לעבוד',
  auto_close: 'משמרת לא נסגרה'
};
var ST = { queue: 'בתור', work: 'בעבודה', stuck: 'תקוע', review: 'ממתין לאישור', done: 'הושלם', deleted: 'נמחק' };
var DAYS = ['שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת', 'ראשון'];
// Task columns: 1 id, 2 title, 3 description, 4 order, 5 estimate hours, 6 deadline, 7 status, 8 percent,
// 9 hours (formula), 10 created, 11 updated, 12 open question.
// Session columns: 1 date, 2 task id, 3 task, 4 start, 5 end, 6 minutes, 7 hours, 8 from %, 9 to %, 10 note, 11 week.
var SNIR_ACTIONS = ['start', 'break_start', 'break_end', 'end', 'task_on', 'task_off', 'block', 'unblock', 'comment'];
var MANAGER_ACTIONS = ['task_add', 'task_edit', 'task_delete', 'reorder', 'answer', 'approve', 'return', 'comment'];

function doGet(e) {
  return respond_(handle_(e.parameter || {}));
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  return respond_(handle_(body));
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(p) {
  var role = p.key && p.key === CONFIG.KEY ? 'snir' : p.key && p.key === CONFIG.MANAGER_KEY ? 'manager' : '';
  if (!role) return { ok: false, error: 'unauthorized' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    if (!ss.getSheetByName(HOURS_TAB)) setup_(ss);
    ensureTaskTabs_(ss);
    var now = new Date();
    closeStale_(ss, now);
    if (!p.action || p.action === 'status') return payload_(ss, now, role, true);
    var allowed = role === 'snir' ? SNIR_ACTIONS : MANAGER_ACTIONS;
    if (allowed.indexOf(p.action) < 0) return payload_(ss, now, role, false, 'bad_action');
    var applied = role === 'snir' ? apply_(ss, p, now) : manage_(ss, p, now);
    SpreadsheetApp.flush();
    return payload_(ss, now, role, !applied.error, applied.error);
  } catch (err) {
    return { ok: false, error: 'server', detail: String(err) };
  } finally {
    lock.releaseLock();
  }
}

// ---------- Snir: shift and task presses ----------

function apply_(ss, p, now) {
  var action = p.action;
  var note = clean_(p.note, 2000);
  var state = readState_(ss).state;
  var work = getWork_();
  var reports = {};
  (Array.isArray(p.reports) ? p.reports : []).forEach(function (r) { if (r && r.id) reports[r.id] = r; });
  var ids = Array.isArray(p.tasks) ? p.tasks.map(String) : [];

  if (action === 'task_on' || action === 'task_off') {
    if (state !== 'working') return { error: 'invalid_state' };
    accrue_(work, now);
    var err = action === 'task_on' ? openTask_(ss, work, String(p.id), now) : closeTask_(ss, work, String(p.id), now, p);
    saveWork_(work);
    return err ? { error: err } : {};
  }
  if (action === 'block' || action === 'unblock' || action === 'comment') return taskTalk_(ss, work, p, now, 'snir');

  var allowed = {
    start: state === 'off',
    break_start: state === 'working',
    break_end: state === 'break',
    end: state === 'working' || state === 'break'
  };
  if (!allowed[action]) return { error: 'invalid_state' };

  var hours = ss.getSheetByName(HOURS_TAB);
  accrue_(work, now);
  if (action === 'start') {
    var row = shiftRow_(hours) + 1;
    var hasTotal = hours.getLastRow() >= row;
    if (hasTotal) hours.insertRowBefore(row);
    hours.getRange(row, 1, 1, 9).setFontWeight('normal');
    hours.getRange(row, 1).setNumberFormat('dd/MM/yyyy');
    hours.getRange(row, 3, 1, 2).setNumberFormat('HH:mm');
    hours.getRange(row, 7).setNumberFormat('0.00');
    hours.getRange(row, 1, 1, 3).setValues([[now, dayName_(now), now]]);
    hours.getRange(row, 6).setValue(0);
    hours.getRange(row, 7).setFormula(
      '=IF(OR(C' + row + '="",D' + row + '=""),"",ROUND(MOD(D' + row + '-C' + row + ',1)*24-N(F' + row + ')/60,2))'
    );
    if (!hasTotal) writeTotal_(hours, row + 1);
    work = { last: now.getTime(), paused: false, active: {}, resume: [] };
    ids.forEach(function (id) { openTask_(ss, work, id, now); });
  } else if (action === 'break_start') {
    Object.keys(work.active).forEach(function (id) { work.resume.push(id); closeTask_(ss, work, id, now, reports[id] || {}); });
    work.paused = true;
  } else if (action === 'break_end') {
    closeBreak_(ss, now);
    work.paused = false;
    work.last = now.getTime();
    work.resume = [];
    ids.forEach(function (id) { openTask_(ss, work, id, now); });
  } else if (action === 'end') {
    if (state === 'break') closeBreak_(ss, now);
    Object.keys(work.active).forEach(function (id) { closeTask_(ss, work, id, now, reports[id] || {}); });
    work.paused = true;
    work.resume = [];
    hours.getRange(shiftRow_(hours), 4).setValue(now);
  }
  saveWork_(work);
  if (note) addNote_(hours, now, note);
  appendLog_(ss, action, now, note);
  if (action === 'end') sendDaySummary_(ss, now, note);
  return {};
}

// Time is split evenly between the tasks that are open at the same moment, so task hours add up to shift hours.
function accrue_(work, now) {
  var ids = Object.keys(work.active);
  var t = now.getTime();
  if (!work.paused && ids.length && work.last) {
    var share = (t - work.last) / 60000 / ids.length;
    ids.forEach(function (id) { work.active[id].acc += share; });
  }
  work.last = t;
}

function openTask_(ss, work, id, now) {
  if (work.active[id]) return '';
  var task = findTask_(ss, id);
  if (!task || [ST.done, ST.deleted, ST.review].indexOf(task.status) >= 0) return 'task_closed';
  work.active[id] = { start: now.getTime(), acc: 0, from: task.pct };
  if (task.status === ST.queue) setTask_(ss, task, { status: ST.work }, now);
  return '';
}

// Closes one task's open stretch: a row in the sessions tab, the new percent, and a line on the shift row.
function closeTask_(ss, work, id, now, report) {
  var open = work.active[id];
  if (!open) return 'not_active';
  delete work.active[id];
  var task = findTask_(ss, id);
  if (!task) return '';
  var note = clean_(report.note, 2000);
  var pct = report.pct === undefined || report.pct === '' || report.pct === null ? task.pct : clamp_(report.pct);
  var minutes = Math.round(open.acc * 10) / 10;
  var start = new Date(open.start);
  var sessionsTab = ss.getSheetByName(SESSIONS_TAB);
  sessionsTab.appendRow([
    start, id, task.title, start, now, minutes, Math.round(minutes / 60 * 100) / 100, open.from, pct, note, weekStart_(start)
  ]);
  // appendRow gives dates a date-time format, so the row's formats are set explicitly.
  var r = sessionsTab.getLastRow();
  sessionsTab.getRange(r, 1).setNumberFormat('dd/MM/yyyy');
  sessionsTab.getRange(r, 4, 1, 2).setNumberFormat('HH:mm');
  sessionsTab.getRange(r, 7).setNumberFormat('0.00');
  sessionsTab.getRange(r, 11).setNumberFormat('dd/MM/yyyy');
  var changes = { pct: pct };
  if (pct >= 100 && task.status !== ST.done) changes.status = ST.review;
  else if (task.status === ST.queue) changes.status = ST.work;
  setTask_(ss, task, changes, now);
  if (note || pct !== open.from) {
    addNote_(ss.getSheetByName(HOURS_TAB), now, task.title + ': ' + (note || 'עדכון התקדמות') + ' (' + open.from + '% עד ' + pct + '%)');
  }
  if (changes.status === ST.review) {
    threadSend_(ss, now, [
      'המשימה "' + task.title + '" הגיעה ל-100% ומחכה לאישור שלך.',
      note ? 'מה נעשה: ' + note : '',
      'לאשר או להחזיר: ' + boardUrl_()
    ]);
  }
  return '';
}

// Questions and comments on a task, from either side.
function taskTalk_(ss, work, p, now, who) {
  var task = findTask_(ss, String(p.id));
  if (!task || task.status === ST.deleted) return { error: 'no_task' };
  var text = clean_(p.text, 3000);
  var name = who === 'snir' ? CONFIG.EMPLOYEE : CONFIG.MANAGER;
  if (p.action === 'block') {
    if (!text) return { error: 'empty' };
    if (work.active[task.id]) {
      accrue_(work, now);
      closeTask_(ss, work, task.id, now, { note: 'נתקע: ' + text });
      saveWork_(work);
      task = findTask_(ss, task.id);
    }
    setTask_(ss, task, { status: ST.stuck, question: text }, now);
    addComment_(ss, now, task, name, 'שאלה: ' + text);
    threadSend_(ss, now, [
      CONFIG.EMPLOYEE + ' תקוע במשימה "' + task.title + '" ומחכה לתשובה שלך.',
      'השאלה: ' + text,
      'לענות: ' + boardUrl_()
    ]);
    return {};
  }
  if (p.action === 'unblock') {
    if (task.status !== ST.stuck) return { error: 'invalid_state' };
    setTask_(ss, task, { status: task.pct > 0 ? ST.work : ST.queue, question: '' }, now);
    addComment_(ss, now, task, name, text || 'המשכתי, הבעיה נפתרה');
    return {};
  }
  if (!text) return { error: 'empty' };
  addComment_(ss, now, task, name, text);
  return {};
}

// ---------- Shafrir: the task board ----------

function manage_(ss, p, now) {
  var action = p.action;
  if (action === 'task_add') {
    var f = taskFields_(p.task || {});
    if (f.error) return f;
    var sheet = ss.getSheetByName(TASKS_TAB);
    var tasks = readTasks_(ss);
    var id = 'T' + (tasks.reduce(function (m, t) { return Math.max(m, Number(t.id.slice(1)) || 0); }, 0) + 1);
    var order = tasks.reduce(function (m, t) { return Math.max(m, t.order); }, 0) + 1;
    var row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1, 1, 12).setValues([[id, f.title, f.desc, order, f.est, f.deadline, ST.queue, 0, '', now, now, '']]);
    sheet.getRange(row, 9).setFormula('=ROUND(SUMIF(\'' + SESSIONS_TAB + '\'!B:B,A' + row + ',\'' + SESSIONS_TAB + '\'!G:G),2)');
    sheet.getRange(row, 6).setNumberFormat('dd/MM/yyyy');
    sheet.getRange(row, 10, 1, 2).setNumberFormat('dd/MM/yyyy HH:mm');
    snirMail_('משימה חדשה מ' + CONFIG.MANAGER + ': ' + f.title, [
      f.desc, f.est ? 'הערכה: ' + f.est + ' שעות' : '', f.deadline ? 'עד ' + fmtDate_(f.deadline) : ''
    ]);
    return {};
  }
  if (action === 'reorder') {
    var order = Array.isArray(p.order) ? p.order.map(String) : [];
    readTasks_(ss).forEach(function (t) {
      var i = order.indexOf(t.id);
      if (i >= 0 && t.order !== i + 1) ss.getSheetByName(TASKS_TAB).getRange(t.row, 4).setValue(i + 1);
    });
    return {};
  }
  var task = findTask_(ss, String(p.id));
  if (!task || task.status === ST.deleted) return { error: 'no_task' };
  var text = clean_(p.text, 3000);
  if (action === 'task_edit') {
    var g = taskFields_(p.task || {});
    if (g.error) return g;
    setTask_(ss, task, { title: g.title, desc: g.desc, est: g.est, deadline: g.deadline }, now);
    return {};
  }
  if (action === 'task_delete') {
    var work = getWork_();
    if (work.active[task.id]) {
      accrue_(work, now);
      closeTask_(ss, work, task.id, now, {});
      saveWork_(work);
    }
    setTask_(ss, findTask_(ss, task.id), { status: ST.deleted }, now);
    snirMail_(CONFIG.MANAGER + ' מחק את המשימה "' + task.title + '"', ['']);
    return {};
  }
  if (action === 'answer') {
    if (!text) return { error: 'empty' };
    var back = task.status === ST.stuck ? (task.pct > 0 ? ST.work : ST.queue) : task.status;
    setTask_(ss, task, { status: back, question: '' }, now);
    addComment_(ss, now, task, CONFIG.MANAGER, text);
    snirMail_(CONFIG.MANAGER + ' ענה על "' + task.title + '"', [task.question ? 'השאלה: ' + task.question : '', 'התשובה: ' + text]);
    return {};
  }
  if (action === 'approve') {
    if (task.status !== ST.review) return { error: 'invalid_state' };
    setTask_(ss, task, { status: ST.done }, now);
    addComment_(ss, now, task, CONFIG.MANAGER, text ? 'אושר: ' + text : 'אושר');
    snirMail_(CONFIG.MANAGER + ' אישר את "' + task.title + '"', [text]);
    return {};
  }
  if (action === 'return') {
    if (task.status !== ST.review && task.status !== ST.done) return { error: 'invalid_state' };
    if (!text) return { error: 'empty' };
    setTask_(ss, task, { status: ST.work }, now);
    addComment_(ss, now, task, CONFIG.MANAGER, 'הוחזר: ' + text);
    snirMail_(CONFIG.MANAGER + ' החזיר את "' + task.title + '"', ['מה צריך: ' + text]);
    return {};
  }
  if (action === 'comment') {
    if (!text) return { error: 'empty' };
    addComment_(ss, now, task, CONFIG.MANAGER, text);
    snirMail_('הערה מ' + CONFIG.MANAGER + ' על "' + task.title + '"', [text]);
    return {};
  }
  return { error: 'bad_action' };
}

function taskFields_(t) {
  var title = clean_(t.title, 200);
  if (!title) return { error: 'empty' };
  var est = t.est === '' || t.est === undefined || t.est === null ? '' : Number(t.est);
  if (est !== '' && !(est >= 0 && est <= 1000)) return { error: 'bad_estimate' };
  var deadline = '';
  if (t.deadline) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t.deadline))) return { error: 'bad_deadline' };
    deadline = Utilities.parseDate(String(t.deadline), CONFIG.TZ, 'yyyy-MM-dd');
  }
  return { title: title, desc: clean_(t.desc, 5000), est: est, deadline: deadline };
}

// ---------- Sheet access ----------

function readTasks_(ss) {
  var sheet = ss.getSheetByName(TASKS_TAB);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 12).getValues().map(function (v, i) {
    return {
      row: i + 2, id: String(v[0]), title: String(v[1]), desc: String(v[2] || ''), order: Number(v[3]) || 0,
      est: v[4] === '' ? '' : Number(v[4]), deadline: v[5] instanceof Date ? v[5] : '', status: String(v[6] || ST.queue),
      pct: Number(v[7]) || 0, created: v[9], updated: v[10], question: String(v[11] || '')
    };
  }).filter(function (t) { return t.id; });
}

function findTask_(ss, id) {
  return readTasks_(ss).filter(function (t) { return t.id === id; })[0] || null;
}

function setTask_(ss, task, changes, now) {
  var sheet = ss.getSheetByName(TASKS_TAB);
  var cols = { title: 2, desc: 3, est: 5, deadline: 6, status: 7, pct: 8, question: 12 };
  Object.keys(changes).forEach(function (k) {
    sheet.getRange(task.row, cols[k]).setValue(changes[k]);
    task[k] = changes[k];
  });
  sheet.getRange(task.row, 11).setValue(now);
}

function addComment_(ss, now, task, who, text) {
  var sheet = ss.getSheetByName(COMMENTS_TAB);
  sheet.appendRow([now, task.id, task.title, who, text]);
  sheet.getRange(sheet.getLastRow(), 1).setNumberFormat('dd/MM/yyyy HH:mm');
}

function readRows_(ss, tab, cols) {
  var sheet = ss.getSheetByName(tab);
  var last = sheet.getLastRow();
  return last < 2 ? [] : sheet.getRange(2, 1, last - 1, cols).getValues();
}

function getWork_() {
  var raw = PropertiesService.getScriptProperties().getProperty('work');
  var w = raw ? JSON.parse(raw) : {};
  return { last: w.last || 0, paused: w.paused !== false, active: w.active || {}, resume: w.resume || [] };
}

function saveWork_(work) {
  PropertiesService.getScriptProperties().setProperty('work', JSON.stringify(work));
}

// ---------- What both apps read ----------

function payload_(ss, now, role, ok, error) {
  var out = status_(ss, now, ok);
  if (error) out.error = error;
  out.role = role;
  var work = getWork_();
  var live = {};
  var ids = Object.keys(work.active);
  ids.forEach(function (id) {
    var extra = !work.paused && work.last ? (now.getTime() - work.last) / 60000 / ids.length : 0;
    live[id] = { since: work.active[id].start, minutes: work.active[id].acc + extra, from: work.active[id].from };
  });
  out.resume = work.resume;
  var sessions = {}, comments = {};
  readRows_(ss, SESSIONS_TAB, 10).forEach(function (v) {
    var id = String(v[1]);
    (sessions[id] = sessions[id] || []).push({
      start: ms_(v[3]), end: ms_(v[4]), minutes: Number(v[5]) || 0, from: Number(v[7]) || 0, to: Number(v[8]) || 0, note: String(v[9] || '')
    });
  });
  readRows_(ss, COMMENTS_TAB, 5).forEach(function (v) {
    var id = String(v[1]);
    (comments[id] = comments[id] || []).push({ at: ms_(v[0]), who: String(v[3]), text: String(v[4]) });
  });
  out.tasks = readTasks_(ss).filter(function (t) { return t.status !== ST.deleted; }).map(function (t) {
    var s = sessions[t.id] || [];
    var minutes = s.reduce(function (m, x) { return m + x.minutes; }, 0) + (live[t.id] ? live[t.id].minutes : 0);
    return {
      id: t.id, title: t.title, desc: t.desc, order: t.order, est: t.est, deadline: ms_(t.deadline),
      status: t.status, pct: t.pct, question: t.question, created: ms_(t.created), updated: ms_(t.updated),
      minutes: Math.round(minutes * 10) / 10, active: live[t.id] || null, sessions: s, comments: comments[t.id] || []
    };
  });
  out.sheetUrl = sheetUrl_();
  return out;
}

function ms_(d) {
  return d instanceof Date ? d.getTime() : null;
}

// ---------- Shift tab (unchanged behaviour) ----------

function closeBreak_(ss, now) {
  var hours = ss.getSheetByName(HOURS_TAB);
  var row = shiftRow_(hours);
  var from = readState_(ss).since;
  var minutes = Math.round((now - from) / 60000);
  var breaks = hours.getRange(row, 5).getDisplayValue();
  var span = time_(from) + ' עד ' + time_(now);
  hours.getRange(row, 5).setValue(breaks ? breaks + ', ' + span : span);
  hours.getRange(row, 6).setValue(Number(hours.getRange(row, 6).getValue() || 0) + minutes);
}

// A shift left open overnight is marked for a manual fix. Its open task stretches keep only the time already counted.
function closeStale_(ss, now) {
  var current = readState_(ss);
  if (current.state === 'off') return;
  var hours = ss.getSheetByName(HOURS_TAB);
  var row = shiftRow_(hours);
  var started = hours.getRange(row, 3).getValue();
  if (!(started instanceof Date)) return;
  if (now - started < CONFIG.STALE_HOURS * 3600000) return;
  hours.getRange(row, 8).setValue('לא נלחץ סיום, צריך להשלים ידנית');
  var work = getWork_();
  work.paused = true;
  Object.keys(work.active).forEach(function (id) { closeTask_(ss, work, id, now, { note: 'לא נלחץ סיום' }); });
  work.resume = [];
  saveWork_(work);
  appendLog_(ss, 'auto_close', now);
}

function readState_(ss) {
  var log = ss.getSheetByName(LOG_TAB);
  var row = log.getLastRow();
  if (row < 2) return { state: 'off', since: null };
  var values = log.getRange(row, 1, 1, 2).getValues()[0];
  var label = values[1];
  var state = 'off';
  if (label === LABELS.start || label === LABELS.break_end) state = 'working';
  if (label === LABELS.break_start) state = 'break';
  return { state: state, since: values[0], label: label };
}

function status_(ss, now, ok) {
  var current = readState_(ss);
  var hours = ss.getSheetByName(HOURS_TAB);
  var row = shiftRow_(hours);
  var out = { ok: ok, state: current.state, now: now.getTime(), employee: CONFIG.EMPLOYEE };
  if (row < 2) return out;

  var v = hours.getRange(row, 1, 1, 8).getValues()[0];
  var breakMinutes = Number(v[5] || 0);
  if (current.state !== 'off') {
    out.startedAt = v[2] instanceof Date ? v[2].getTime() : null;
    out.startLabel = hours.getRange(row, 3).getDisplayValue();
    out.breakMinutes = breakMinutes;
    if (current.state === 'break') out.breakStartedAt = current.since.getTime();
  } else if (v[3] instanceof Date && dateKey_(v[3]) === dateKey_(now)) {
    out.last = {
      start: hours.getRange(row, 3).getDisplayValue(),
      end: hours.getRange(row, 4).getDisplayValue(),
      breakMinutes: breakMinutes,
      netMinutes: Math.round((v[3] - v[2]) / 60000) - breakMinutes
    };
  }
  return out;
}

// The total row always sits right under the newest shift, so the newest shift is not simply the last row.
function shiftRow_(hours) {
  var row = hours.getLastRow();
  return row > 1 && hours.getRange(row, 2).getValue() === TOTAL_LABEL ? row - 1 : row;
}

function writeTotal_(hours, row) {
  hours.getRange(row, 2).setValue(TOTAL_LABEL);
  hours.getRange(row, 7).setFormula('=SUM(INDIRECT("G2:G"&ROW()-1))').setNumberFormat('0.00');
  hours.getRange(row, 1, 1, 9).setFontWeight('bold');
}

function appendLog_(ss, action, now, message) {
  ss.getSheetByName(LOG_TAB).appendRow([now, LABELS[action], message || '']);
}

// What was done, one line per note, kept on the shift row in column I.
function addNote_(hours, now, note) {
  var cell = hours.getRange(shiftRow_(hours), 9);
  var before = cell.getValue();
  cell.setValue((before ? before + '\n' : '') + time_(now) + ' ' + note);
}

// ---------- Mail ----------

// End of day: per task hours, progress and notes, to Shafrir's day thread and to Snir.
function sendDaySummary_(ss, now, note) {
  var hours = ss.getSheetByName(HOURS_TAB);
  var day = daySummary_(hours, now);
  var perTask = {};
  readRows_(ss, SESSIONS_TAB, 10).forEach(function (v) {
    if (!(v[3] instanceof Date) || dateKey_(v[3]) !== dateKey_(now)) return;
    var id = String(v[1]);
    var t = perTask[id] = perTask[id] || { title: String(v[2]), minutes: 0, from: Number(v[7]) || 0, to: 0, notes: [] };
    t.minutes += Number(v[5]) || 0;
    t.to = Number(v[8]) || 0;
    if (v[9]) t.notes.push(String(v[9]));
  });
  var lines = [
    CONFIG.EMPLOYEE + ' סיים לעבוד בשעה ' + time_(now) + '.',
    '',
    'התחלה ' + day.start + ', סיום ' + time_(now) + ', הפסקות ' + (day.breaks || 'אין'),
    'סה"כ שעות עבודה היום ' + day.total.toFixed(2)
  ];
  var ids = Object.keys(perTask);
  if (ids.length) {
    lines.push('', 'לפי משימות:');
    ids.forEach(function (id) {
      var t = perTask[id];
      lines.push('', t.title + ': ' + (t.minutes / 60).toFixed(2) + ' שעות, ' + t.from + '% עד ' + t.to + '%');
      t.notes.forEach(function (n) { lines.push('  ' + n); });
    });
  }
  if (note) lines.push('', 'הערה כללית: ' + note);
  lines.push('', 'לוח המשימות: ' + boardUrl_(), 'קובץ השעות: ' + sheetUrl_());
  threadSend_(ss, now, lines);
  if (CONFIG.REPORT_EMAILS) {
    try {
      MailApp.sendEmail({ to: CONFIG.REPORT_EMAILS, subject: 'שפריר, סיכום יום ' + Utilities.formatDate(now, CONFIG.TZ, 'dd/MM/yyyy') + ', ' + day.total.toFixed(2) + ' שעות', body: lines.join('\n') });
    } catch (err) {
      console.error(err);
    }
  }
}

// One Gmail thread per day for Shafrir. Sent through the Gmail advanced service so replies stay threaded.
function threadSend_(ss, now, lines) {
  if (!CONFIG.THREAD_EMAILS) return;
  lines = lines.filter(function (l) { return l !== null && l !== undefined; });
  try {
    var props = PropertiesService.getScriptProperties();
    var thread = JSON.parse(props.getProperty('thread') || '{}');
    var today = dateKey_(now);
    var isNew = thread.date !== today || thread.to !== CONFIG.THREAD_EMAILS;
    if (isNew) thread = { date: today, to: CONFIG.THREAD_EMAILS, subject: CONFIG.EMPLOYEE + ', יום עבודה ' + Utilities.formatDate(now, CONFIG.TZ, 'dd/MM/yyyy') };
    var headers = [
      'To: ' + CONFIG.THREAD_EMAILS,
      'Subject: =?UTF-8?B?' + Utilities.base64Encode(thread.subject, Utilities.Charset.UTF_8) + '?=',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64'
    ];
    if (!isNew) headers.push('In-Reply-To: ' + thread.msgId, 'References: ' + thread.msgId);
    var html = '<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px">' +
      lines.map(function (l) { return linkify_(escapeHtml_(l)); }).join('<br>').replace(/\n/g, '<br>') + '</div>';
    var raw = headers.join('\r\n') + '\r\n\r\n' + Utilities.base64Encode(html, Utilities.Charset.UTF_8);
    var resource = { raw: Utilities.base64EncodeWebSafe(raw) };
    if (!isNew) resource.threadId = thread.threadId;
    var sent = Gmail.Users.Messages.send(resource, 'me');
    if (isNew) {
      thread.threadId = sent.threadId;
      var meta = Gmail.Users.Messages.get('me', sent.id, { format: 'metadata', metadataHeaders: ['Message-ID'] });
      thread.msgId = meta.payload.headers.filter(function (h) { return /^message-id$/i.test(h.name); })[0].value;
      props.setProperty('thread', JSON.stringify(thread));
    }
  } catch (err) {
    console.error(err);
    var hours = ss.getSheetByName(HOURS_TAB);
    if (shiftRow_(hours) > 1) hours.getRange(shiftRow_(hours), 8).setValue('מייל לשפריר לא נשלח');
  }
}

function snirMail_(subject, lines) {
  if (!CONFIG.REPORT_EMAILS) return;
  try {
    var body = lines.filter(function (l) { return l; }).join('\n') + '\n\nהאפליקציה: ' + CONFIG.APP_URL + CONFIG.KEY;
    MailApp.sendEmail({ to: CONFIG.REPORT_EMAILS, subject: subject, body: body });
  } catch (err) {
    console.error(err);
  }
}

// All shifts of the given day together: first start, breaks, net hours and notes.
function daySummary_(hours, now) {
  var last = shiftRow_(hours);
  var out = { start: '', breaks: '', total: 0, notes: '' };
  if (last < 2) return out;
  var values = hours.getRange(2, 1, last - 1, 9).getValues();
  var shown = hours.getRange(2, 1, last - 1, 9).getDisplayValues();
  values.forEach(function (v, i) {
    if (!(v[0] instanceof Date) || dateKey_(v[0]) !== dateKey_(now)) return;
    var d = shown[i];
    if (!out.start) out.start = d[2];
    if (d[4]) out.breaks += (out.breaks ? ', ' : '') + d[4];
    out.total += Number(v[6]) || 0;
    if (d[8]) out.notes += (out.notes ? '\n' : '') + d[8];
  });
  return out;
}

// Runs from a time trigger. One email per press: the reminder is keyed by the last press time.
function remindOpenShift() {
  if (!CONFIG.REMIND_EMAILS) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    var current = readState_(ss);
    if (current.state === 'off' || !(current.since instanceof Date)) return;
    if (new Date() - current.since < CONFIG.REMIND_HOURS * 3600000) return;
    var props = PropertiesService.getScriptProperties();
    var key = String(current.since.getTime());
    if (props.getProperty('remindedFor') === key) return;
    var onBreak = current.state === 'break';
    MailApp.sendEmail({
      to: CONFIG.REMIND_EMAILS,
      subject: 'שפריר: משמרת פתוחה, אין לחיצה כבר ' + CONFIG.REMIND_HOURS + ' שעות',
      body: 'הלחיצה האחרונה הייתה "' + current.label + '" בשעה ' + time_(current.since) + '.\n' +
        (onBreak ? 'המשמרת עדיין פתוחה, במצב הפסקה.' : 'המשמרת עדיין פתוחה.') +
        '\nאם סיימת, צריך ללחוץ "' + LABELS.end + '":\n' + CONFIG.APP_URL + CONFIG.KEY
    });
    props.setProperty('remindedFor', key);
  } finally {
    lock.releaseLock();
  }
}

// Run once from the editor to schedule remindOpenShift every 10 minutes.
function installReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'remindOpenShift') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('remindOpenShift').timeBased().everyMinutes(10).create();
}

// ---------- Tabs ----------

function setup_(ss) {
  ss.setSpreadsheetTimeZone(CONFIG.TZ);
  var hours = ss.getSheets()[0].setName(HOURS_TAB);
  hours.getRange(1, 1, 1, 9).setValues([['תאריך', 'יום', 'התחלה', 'סיום', 'הפסקות', 'דקות הפסקה', 'שעות נטו', 'הערה', 'מה עשיתי']]);
  hours.getRange('I2:I').setWrap(true);
  hours.getRange('A2:A').setNumberFormat('dd/MM/yyyy');
  hours.getRange('C2:D').setNumberFormat('HH:mm');
  hours.getRange('G2:G').setNumberFormat('0.00');
  hours.setColumnWidth(5, 170);
  hours.setColumnWidth(8, 220);
  hours.setColumnWidth(9, 320);
  styleTab_(hours);

  var log = ss.insertSheet(LOG_TAB);
  log.getRange(1, 1, 1, 3).setValues([['תאריך ושעה', 'פעולה', 'מה עשיתי']]);
  log.getRange('A2:A').setNumberFormat('dd/MM/yyyy HH:mm:ss');
  log.setColumnWidth(1, 170);
  log.setColumnWidth(2, 170);
  styleTab_(log);

  var monthly = ss.insertSheet(MONTHLY_TAB);
  monthly.getRange('A1').setFormula(
    "=QUERY('" + HOURS_TAB + "'!A:G,\"select year(A), month(A)+1, count(A), sum(G) where A is not null " +
    "group by year(A), month(A)+1 order by year(A), month(A)+1 " +
    "label year(A) 'שנה', month(A)+1 'חודש', count(A) 'משמרות', sum(G) 'שעות'\",1)"
  );
  styleTab_(monthly);
}

function ensureTaskTabs_(ss) {
  if (ss.getSheetByName(TASKS_TAB)) return;
  var tasks = ss.insertSheet(TASKS_TAB, 0);
  tasks.getRange(1, 1, 1, 12).setValues([['מזהה', 'משימה', 'תיאור', 'סדר', 'הערכת שעות', 'דדליין', 'סטטוס', 'אחוז', 'שעות בפועל', 'נוצרה', 'עודכנה', 'שאלה פתוחה']]);
  tasks.getRange('F2:F').setNumberFormat('dd/MM/yyyy');
  tasks.getRange('J2:K').setNumberFormat('dd/MM/yyyy HH:mm');
  tasks.getRange('C2:C').setWrap(true);
  tasks.setColumnWidth(2, 220);
  tasks.setColumnWidth(3, 320);
  tasks.setColumnWidth(12, 260);
  styleTab_(tasks);

  var sessions = ss.insertSheet(SESSIONS_TAB, 1);
  sessions.getRange(1, 1, 1, 11).setValues([['תאריך', 'מזהה משימה', 'משימה', 'התחלה', 'סיום', 'דקות', 'שעות', 'מאחוז', 'לאחוז', 'מה עשיתי', 'שבוע']]);
  sessions.getRange('A2:A').setNumberFormat('dd/MM/yyyy');
  sessions.getRange('D2:E').setNumberFormat('HH:mm');
  sessions.getRange('G2:G').setNumberFormat('0.00');
  sessions.getRange('K2:K').setNumberFormat('dd/MM/yyyy');
  sessions.getRange('J2:J').setWrap(true);
  sessions.setColumnWidth(3, 220);
  sessions.setColumnWidth(10, 320);
  styleTab_(sessions);

  var comments = ss.insertSheet(COMMENTS_TAB);
  comments.getRange(1, 1, 1, 5).setValues([['זמן', 'מזהה משימה', 'משימה', 'מי', 'הערה']]);
  comments.getRange('A2:A').setNumberFormat('dd/MM/yyyy HH:mm');
  comments.getRange('E2:E').setWrap(true);
  comments.setColumnWidth(3, 220);
  comments.setColumnWidth(5, 360);
  styleTab_(comments);

  var weekly = ss.insertSheet(WEEKLY_TAB);
  weekly.getRange('A1').setFormula(
    "=QUERY('" + SESSIONS_TAB + "'!A:K,\"select K, C, sum(G), max(I) where A is not null group by K, C order by K desc " +
    "label K 'שבוע שמתחיל ב', C 'משימה', sum(G) 'שעות', max(I) 'אחוז בסוף השבוע'\",1)"
  );
  weekly.getRange('A2:A').setNumberFormat('dd/MM/yyyy');
  weekly.setColumnWidth(2, 240);
  styleTab_(weekly);
}

function styleTab_(sheet) {
  sheet.setRightToLeft(true);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getMaxColumns()).setFontWeight('bold');
}

// ---------- Small helpers ----------

function clean_(s, max) {
  return String(s === undefined || s === null ? '' : s).trim().slice(0, max);
}

function clamp_(n) {
  n = Math.round(Number(n));
  return isNaN(n) ? 0 : Math.max(0, Math.min(100, n));
}

// Israeli week: Sunday.
function weekStart_(d) {
  var key = dateKey_(d);
  var day = Number(Utilities.formatDate(d, CONFIG.TZ, 'u')) % 7; // Sunday 0
  var base = Utilities.parseDate(key, CONFIG.TZ, 'yyyy-MM-dd');
  return new Date(base.getTime() - day * 86400000);
}

function fmtDate_(d) {
  return Utilities.formatDate(d, CONFIG.TZ, 'dd/MM/yyyy');
}

function boardUrl_() {
  return CONFIG.BOARD_URL + CONFIG.MANAGER_KEY;
}

function sheetUrl_() {
  return 'https://docs.google.com/spreadsheets/d/' + CONFIG.SHEET_ID + '/edit';
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function linkify_(s) {
  return s.replace(/https:\/\/\S+/g, function (u) { return '<a href="' + u + '">' + u + '</a>'; });
}

function dayName_(d) {
  return DAYS[Number(Utilities.formatDate(d, CONFIG.TZ, 'u')) - 1];
}

function time_(d) {
  return Utilities.formatDate(d, CONFIG.TZ, 'HH:mm');
}

function dateKey_(d) {
  return Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd');
}
