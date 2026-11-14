(function () {
  var $ = function (id) { return document.getElementById(id); };
  var el = { status: $('status'), clock: $('clock'), detail: $('detail'), toast: $('toast'), start: $('start'), pause: $('pause'), end: $('end') };

  // The key arrives once in the install link. Stored so the app keeps working if iOS drops the query.
  var key = new URLSearchParams(location.search).get('k');
  try {
    if (key) localStorage.setItem('hours_key', key);
    else key = localStorage.getItem('hours_key');
  } catch (e) {}

  var current = null;
  var clockSkew = 0;
  var busy = false;
  var openDetail = null;

  var OPEN = ['בתור', 'בעבודה', 'תקוע'];

  function call(body) {
    var options = { redirect: 'follow' };
    var url = window.HOURS_API;
    if (!body) {
      url += '?key=' + encodeURIComponent(key) + '&t=' + Date.now();
    } else {
      body.key = key;
      options.method = 'POST';
      options.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(function (r) { return r.json(); });
  }

  function num(t) { return t.id.replace(/^T/, '') + '. '; }
  function nt(t) { return esc(num(t) + t.title); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function duration(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }
  function hm(minutes) {
    minutes = Math.round(minutes);
    return Math.floor(minutes / 60) + ':' + pad(minutes % 60);
  }
  function hours(minutes) { return (minutes / 60).toFixed(1).replace(/\.0$/, ''); }
  var fmt = function (ms, opts) { return new Date(ms).toLocaleString('he-IL', Object.assign({ timeZone: 'Asia/Jerusalem' }, opts)); };
  var day = function (ms) { return fmt(ms, { day: '2-digit', month: '2-digit' }); };
  var clock = function (ms) { return fmt(ms, { hour: '2-digit', minute: '2-digit' }); };
  function nowMs() { return Date.now() + clockSkew; }

  function liveMinutes(t) {
    if (!t.active || !current || current.state !== 'working') return t.active ? t.active.minutes : 0;
    var n = current.tasks.filter(function (x) { return x.active; }).length || 1;
    return t.active.minutes + (nowMs() - current.now) / 60000 / n;
  }
  function totalMinutes(t) {
    return t.minutes + (t.active ? liveMinutes(t) - t.active.minutes : 0);
  }

  function tick() {
    if (!current) return;
    var now = nowMs();
    if (current.state === 'working' && current.startedAt) {
      el.clock.textContent = duration(now - current.startedAt - current.breakMinutes * 60000);
    } else if (current.state === 'break') {
      el.clock.textContent = duration(now - current.breakStartedAt);
    }
    document.querySelectorAll('[data-live]').forEach(function (node) {
      var t = taskById(node.getAttribute('data-live'));
      if (t) node.textContent = 'עובד על זה ' + hm(liveMinutes(t));
    });
  }

  function taskById(id) {
    return current && current.tasks.filter(function (t) { return t.id === id; })[0];
  }

  function render(s) {
    current = s;
    clockSkew = s.now - Date.now();
    var isOff = s.state === 'off';
    var isBreak = s.state === 'break';

    el.start.hidden = !isOff;
    el.start.disabled = !isOff;
    el.pause.hidden = isOff;
    el.end.hidden = isOff;
    el.pause.textContent = isBreak ? 'חזרתי מהפסקה' : 'יצאתי להפסקה';

    if (isBreak) {
      el.status.textContent = 'בהפסקה';
      el.detail.textContent = 'התחלת ב ' + s.startLabel;
    } else if (!isOff) {
      var active = s.tasks.filter(function (t) { return t.active; });
      el.status.textContent = active.length === 1 ? 'עובד על ' + active[0].title : active.length ? 'עובד על ' + active.length + ' משימות' : 'בעבודה, בלי משימה פתוחה';
      el.detail.textContent = 'התחלת ב ' + s.startLabel + (s.breakMinutes ? ', הפסקות ' + s.breakMinutes + ' דקות' : '');
    } else if (s.last) {
      el.status.textContent = 'סיימת להיום';
      el.clock.textContent = hm(s.last.netMinutes);
      el.detail.textContent = s.last.start + ' עד ' + s.last.end + (s.last.breakMinutes ? ', הפסקות ' + s.last.breakMinutes + ' דקות' : '');
    } else {
      el.status.textContent = 'לא בעבודה';
      el.clock.textContent = '0:00';
      el.detail.textContent = '';
    }
    renderTasks();
    if (openDetail) showDetail(openDetail, true);
    tick();
  }

  function stateLabel(t) {
    var cls = t.status === 'תקוע' ? 'stuck' : t.status === 'ממתין לאישור' || t.status === 'הושלם' ? 'review' : '';
    return '<span class="task-state ' + cls + '">' + esc(t.status) + '</span>';
  }

  function metaLine(t) {
    var parts = [hours(totalMinutes(t)) + (t.est !== '' && t.est != null ? ' מתוך ' + t.est : '') + ' שעות'];
    if (t.deadline) {
      var late = t.deadline < nowMs() + 2 * 86400000 && t.pct < 70;
      parts.push('<span class="' + (late ? 'late' : '') + '">עד ' + day(t.deadline) + '</span>');
    }
    return parts.map(function (p) { return '<span>' + p + '</span>'; }).join('');
  }

  function renderTasks() {
    var list = current.tasks.slice().sort(function (a, b) { return a.order - b.order; });
    var open = list.filter(function (t) { return OPEN.indexOf(t.status) >= 0 || t.status === 'ממתין לאישור'; });
    var done = list.filter(function (t) { return t.status === 'הושלם'; });
    var working = current.state === 'working';
    $('tasks').innerHTML = open.length ? open.map(function (t) {
      var canToggle = working && OPEN.indexOf(t.status) >= 0;
      return '<div class="task' + (t.active ? ' active' : '') + '">' +
        '<div class="task-top"><p class="task-title" data-open="' + esc(t.id) + '">' + nt(t) + '</p>' + stateLabel(t) + '</div>' +
        '<div class="bar" role="img" aria-label="' + t.pct + ' אחוז"><span style="width:' + t.pct + '%"></span></div>' +
        '<div class="task-meta"><span><b>' + t.pct + '%</b></span>' + metaLine(t) +
        (t.active ? '<span class="task-live" data-live="' + esc(t.id) + '"></span>' : '') + '</div>' + notesBlock(t) +
        '<div class="task-actions">' +
        (canToggle ? '<button type="button" class="' + (t.active ? 'on' : '') + '" data-toggle="' + esc(t.id) + '">' + (t.active ? 'עצרתי' : 'לעבוד על זה') + '</button>' : '') +
        '<button type="button" data-open="' + esc(t.id) + '">פרטים</button></div></div>';
    }).join('') : '<p class="empty">אין משימות פתוחות. שפריר מוסיף משימות מהלוח שלו.</p>';
    $('done-wrap').hidden = !done.length;
    $('done-sum').textContent = 'הושלמו (' + done.length + ')';
    done.sort(function (a, b) { return b.updated - a.updated; });
    $('done').innerHTML = done.map(function (t) {
      return '<li data-open="' + esc(t.id) + '"><b>' + nt(t) + '</b><br><span class="when">' + hours(t.minutes) + ' שעות</span></li>';
    }).join('');
  }

  // Every comment and work update of a task, newest first, opened in place on the card.
  var openNotes = {};
  function notesBlock(t) {
    var items = t.comments.map(function (c) {
      return { at: c.at, html: '<b>' + esc(c.who) + '</b><br>' + esc(c.text) };
    }).concat(t.sessions.map(function (x, i) {
      return { at: x.end, html: '<b>עדכון ' + (i + 1) + '</b> ' + clock(x.start) + ' עד ' + clock(x.end) + ', ' + hm(x.minutes) + ' שעות, ' + x.from + '% עד ' + x.to + '%' + (x.note ? '<br>' + esc(x.note) : '') };
    }));
    if (!items.length) return '';
    items.sort(function (a, b) { return b.at - a.at; });
    var open = openNotes[t.id];
    return '<button type="button" class="notes-toggle" data-notes="' + esc(t.id) + '" aria-expanded="' + !!open + '">' +
      (open ? 'סגירת הערות' : 'פתח הערות') + ' (' + items.length + ')</button>' +
      (open ? '<ul class="notes-list">' + items.map(function (i) {
        return '<li><span class="when">' + day(i.at) + ' ' + clock(i.at) + '</span> ' + i.html + '</li>';
      }).join('') + '</ul>' : '');
  }

  function toast(text, isError) {
    el.toast.textContent = text;
    el.toast.className = 'show' + (isError ? ' err' : '');
    clearTimeout(toast.timer);
    if (!isError) toast.timer = setTimeout(function () { el.toast.className = ''; el.toast.textContent = ''; }, 3500);
  }

  function setBusy(on) {
    busy = on;
    document.body.classList.toggle('busy', on);
  }

  var ERRORS = { invalid_state: 'המצב כבר התעדכן, בדוק שזה נכון', task_closed: 'המשימה סגורה', empty: 'צריך לכתוב משהו' };

  function send(body, doneText) {
    if (busy) return Promise.resolve();
    setBusy(true);
    toast('שולח');
    return call(body).then(function (s) {
      if (s.error === 'unauthorized') throw new Error('unauthorized');
      if (s.tasks) render(s);
      if (s.error) toast(ERRORS[s.error] || 'לא נשמר, נסה שוב', !ERRORS[s.error]);
      else toast(doneText);
    }).catch(function (e) {
      toast(e.message === 'unauthorized' ? 'הקישור לא תקין' : 'לא נשמר, בדוק אינטרנט ונסה שוב', true);
    }).then(function () { setBusy(false); });
  }

  function refresh() {
    if (busy || !key) return;
    if (!$('pick').hidden || !$('report').hidden) return;
    call().then(function (s) {
      if (s.error === 'unauthorized') { el.status.textContent = 'הקישור לא תקין'; return; }
      if (s.tasks) { render(s); if (el.toast.classList.contains('err')) { el.toast.className = ''; el.toast.textContent = ''; } }
    }).catch(function () {
      if (!current) el.status.textContent = 'אין חיבור';
      toast('אין חיבור לאינטרנט. שום דבר לא נשמר עד שיחזור', true);
    });
  }

  // ---------- Dictation, into whichever box the mic button points at ----------
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognition = null, micButton = null;
  var micStatus = $('mic-status');

  function stopMic() {
    if (recognition) { recognition.onend = null; recognition.stop(); recognition = null; }
    if (micButton) { micButton.classList.remove('on'); micButton.textContent = 'הקלטה קולית'; micButton = null; }
  }
  function startMic(button) {
    var box = $(button.getAttribute('data-target'));
    var base = box.value ? box.value.replace(/\s*$/, ' ') : '';
    recognition = new SpeechRecognition();
    recognition.lang = 'he-IL';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = function (e) {
      var text = '';
      for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      box.value = base + text;
    };
    recognition.onerror = function (e) {
      micStatus.textContent = e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'אין הרשאה למיקרופון. אפשר להכתיב עם המיקרופון במקלדת'
        : 'ההקלטה נעצרה, אפשר לנסות שוב';
    };
    recognition.onend = function () { stopMic(); };
    recognition.start();
    micButton = button;
    button.classList.add('on');
    button.textContent = 'עצירת הקלטה';
    micStatus.textContent = 'מקליט, מדבר ונכתב';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.mic');
    if (!b) return;
    if (micButton === b) { stopMic(); return; }
    stopMic();
    try { startMic(b); } catch (err) { stopMic(); micStatus.textContent = 'ההקלטה לא זמינה, אפשר להכתיב עם המיקרופון במקלדת'; }
  });
  function micMarkup(target) {
    return SpeechRecognition ? '<div class="row"><button class="soft mic" type="button" data-target="' + target + '">הקלטה קולית</button></div>' : '';
  }

  // ---------- Pick tasks: start of day and back from a break ----------
  var pickAction = null;
  function openPick(action) {
    pickAction = action;
    var open = current.tasks.filter(function (t) { return OPEN.indexOf(t.status) >= 0; }).sort(function (a, b) { return a.order - b.order; });
    var pre = action === 'break_end' ? current.resume : [];
    $('pick-title').textContent = action === 'break_end' ? 'חזרת. על מה אתה עובד?' : 'על מה אתה עובד היום?';
    $('pick-ok').textContent = action === 'break_end' ? 'חזרתי מהפסקה' : 'התחלתי לעבוד';
    $('pick-list').innerHTML = open.length ? open.map(function (t) {
      return '<label class="pick"><input type="checkbox" value="' + esc(t.id) + '"' + (pre.indexOf(t.id) >= 0 ? ' checked' : '') + '>' +
        '<span>' + nt(t) + '<small>' + t.pct + '%, ' + esc(t.status) + '</small></span></label>';
    }).join('') : '<p class="hint">אין משימות פתוחות. אפשר להתחיל בלי משימה.</p>';
    $('pick').hidden = false;
  }
  $('pick-cancel').addEventListener('click', function () { $('pick').hidden = true; });
  $('pick-ok').addEventListener('click', function () {
    var ids = Array.prototype.map.call(document.querySelectorAll('#pick-list input:checked'), function (i) { return i.value; });
    $('pick').hidden = true;
    send({ action: pickAction, tasks: ids }, pickAction === 'break_end' ? 'נרשמה חזרה' : 'נרשמה התחלה');
  });

  // ---------- Report: what was done and how far, per open task ----------
  var reportAction = null, reportTask = null;
  function openReport(action, onlyId) {
    reportAction = action;
    reportTask = onlyId || null;
    var tasks = current.tasks.filter(function (t) { return t.active && (!onlyId || t.id === onlyId); });
    var general = action !== 'task_off';
    $('report-title').textContent = action === 'end' ? 'סיום יום' : action === 'break_start' ? 'יציאה להפסקה' : 'עדכון התקדמות';
    $('report-ok').textContent = action === 'end' ? 'סיימתי לעבוד' : action === 'break_start' ? 'יצאתי להפסקה' : 'שמירה';
    $('report-general').hidden = !general;
    $('report-general-label').textContent = action === 'end' ? 'הערה כללית ליום, לא חובה' : 'למה יצאת להפסקה? לא חובה';
    $('report-general-text').value = '';
    $('report-tasks').innerHTML = tasks.map(function (t, i) {
      return '<div class="block" data-task="' + esc(t.id) + '"><p class="block-title">' + nt(t) + '</p>' +
        '<label class="hint" for="rn' + i + '">מה עשית? כמה מילים</label>' +
        '<textarea id="rn' + i + '" dir="rtl"></textarea>' + micMarkup('rn' + i) +
        '<label class="hint" for="rp' + i + '">כמה המשימה מוכנה עכשיו?</label>' +
        '<div class="pct"><input id="rp' + i + '" type="range" min="0" max="100" step="5" value="' + t.pct + '"><output>' + t.pct + '%</output></div></div>';
    }).join('');
    micStatus.textContent = SpeechRecognition ? '' : 'אפשר להכתיב עם המיקרופון במקלדת';
    $('report').hidden = false;
  }
  $('report').addEventListener('input', function (e) {
    if (e.target.type === 'range') e.target.nextElementSibling.textContent = e.target.value + '%';
  });
  $('report-cancel').addEventListener('click', function () { stopMic(); $('report').hidden = true; });
  $('report-ok').addEventListener('click', function () {
    stopMic();
    var reports = Array.prototype.map.call(document.querySelectorAll('#report-tasks .block'), function (b) {
      return { id: b.getAttribute('data-task'), note: b.querySelector('textarea').value.trim(), pct: Number(b.querySelector('input').value) };
    });
    $('report').hidden = true;
    if (reportAction === 'task_off') {
      var r = reports[0] || { id: reportTask };
      send({ action: 'task_off', id: r.id, note: r.note, pct: r.pct }, 'נשמר');
    } else {
      send({ action: reportAction, note: $('report-general-text').value.trim(), reports: reports }, reportAction === 'end' ? 'נרשם סיום' : 'נרשמה הפסקה');
    }
  });

  // ---------- Task details: history, comments, stuck ----------
  function showDetail(id, keepInputs) {
    var t = taskById(id);
    if (!t) { closeDetail(); return; }
    openDetail = id;
    if (keepInputs && !$('detail-sheet').hidden && document.activeElement && document.activeElement.closest('#detail-sheet textarea')) return;
    $('d-title').textContent = num(t) + t.title;
    var forecast = t.pct > 0 && t.pct < 100 ? hours(totalMinutes(t) * (100 - t.pct) / t.pct) + ' שעות' : '';
    var html = '<div class="stats"><div class="stat"><b>' + t.pct + '%</b><span>התקדמות</span></div>' +
      '<div class="stat"><b>' + hours(totalMinutes(t)) + '</b><span>שעות' + (t.est !== '' && t.est != null ? ' מתוך ' + t.est : '') + '</span></div>' +
      '<div class="stat"><b>' + (t.deadline ? day(t.deadline) : 'אין') + '</b><span>דדליין</span></div></div>';
    if (forecast) html += '<p class="hint">לפי הקצב עד עכשיו נשארו עוד כ-' + forecast + '.</p>';
    if (t.desc) html += '<p class="desc">' + esc(t.desc) + '</p>';
    if (t.status === 'תקוע') {
      html += '<p class="question"><b>שאלת את שפריר:</b> ' + esc(t.question) + '</p>' +
        '<button type="button" class="soft" data-unblock="' + esc(t.id) + '">הבעיה נפתרה, ממשיך</button>';
    } else if (OPEN.indexOf(t.status) >= 0) {
      html += '<label class="hint" for="d-stuck">תקוע? כתוב לשפריר מה חסר, הוא יקבל מייל</label>' +
        '<textarea id="d-stuck" dir="rtl"></textarea>' + micMarkup('d-stuck') +
        '<button type="button" class="soft" data-block="' + esc(t.id) + '">אני תקוע, שלח שאלה</button>';
    }
    html += '<h4>הערות</h4>' + (t.comments.length ? '<ul class="list">' + t.comments.slice().reverse().map(function (c) {
      return '<li><span class="who">' + esc(c.who) + '</span> <span class="when">' + day(c.at) + ' ' + clock(c.at) + '</span><br>' + esc(c.text) + '</li>';
    }).join('') + '</ul>' : '<p class="hint">אין הערות עדיין</p>') +
      '<textarea id="d-comment" dir="rtl" placeholder="הערה לשפריר"></textarea>' +
      '<button type="button" class="soft" data-comment="' + esc(t.id) + '">שליחת הערה</button>';
    html += '<h4>היסטוריית עבודה</h4>' + (t.sessions.length ? '<ul class="list">' + t.sessions.map(function (s, i) { s.n = i + 1; return s; }).slice().reverse().map(function (s) {
      return '<li><span class="who">עדכון ' + s.n + ':</span> <span class="who">' + day(s.start) + ' ' + clock(s.start) + ' עד ' + clock(s.end) + '</span> <span class="when">' + hm(s.minutes) + ' שעות, ' + s.from + '% עד ' + s.to + '%</span>' +
        (s.note ? '<br>' + esc(s.note) : '') + '</li>';
    }).join('') + '</ul>' : '<p class="hint">עוד לא עבדת על המשימה</p>');
    $('d-body').innerHTML = html;
    $('d-body').style.display = 'flex';
    $('d-body').style.flexDirection = 'column';
    $('d-body').style.gap = '10px';
    $('detail-sheet').hidden = false;
  }
  function closeDetail() { openDetail = null; stopMic(); $('detail-sheet').hidden = true; }
  $('d-close').addEventListener('click', closeDetail);
  $('d-body').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || busy) return;
    if (b.hasAttribute('data-block')) {
      var q = $('d-stuck').value.trim();
      if (!q) { toast('כתוב מה חסר לך'); return; }
      stopMic();
      send({ action: 'block', id: b.getAttribute('data-block'), text: q }, 'השאלה נשלחה לשפריר');
    } else if (b.hasAttribute('data-unblock')) {
      send({ action: 'unblock', id: b.getAttribute('data-unblock') }, 'המשימה חזרה לעבודה');
    } else if (b.hasAttribute('data-comment')) {
      var c = $('d-comment').value.trim();
      if (!c) return;
      send({ action: 'comment', id: b.getAttribute('data-comment'), text: c }, 'ההערה נשמרה');
    }
  });

  document.addEventListener('click', function (e) {
    var tn = e.target.closest('[data-notes]');
    if (tn) { var nid = tn.getAttribute('data-notes'); openNotes[nid] = !openNotes[nid]; renderTasks(); tick(); return; }
    var open = e.target.closest('[data-open]');
    if (open) { showDetail(open.getAttribute('data-open')); return; }
    var tog = e.target.closest('[data-toggle]');
    if (!tog || busy) return;
    var t = taskById(tog.getAttribute('data-toggle'));
    if (t.active) openReport('task_off', t.id);
    else send({ action: 'task_on', id: t.id }, 'התחלת לעבוד על ' + t.title);
  });

  el.start.addEventListener('click', function () { openPick('start'); });
  el.pause.addEventListener('click', function () {
    if (current && current.state === 'break') openPick('break_end');
    else openReport('break_start');
  });
  el.end.addEventListener('click', function () { openReport('end'); });

  if (!key) {
    el.status.textContent = 'חסר קישור התקנה';
    el.detail.textContent = 'צריך לפתוח את קישור ההתקנה המלא';
    return;
  }

  setInterval(tick, 1000);
  setInterval(function () { if (!document.hidden) refresh(); }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  refresh();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
