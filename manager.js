(function () {
  var $ = function (id) { return document.getElementById(id); };

  // Shafrir's board key arrives once in his link (?m=) and is remembered on the device.
  var key = new URLSearchParams(location.search).get('m');
  try {
    if (key) localStorage.setItem('board_key', key);
    else key = localStorage.getItem('board_key');
  } catch (e) {}

  var data = null, skew = 0, busy = false, editing = null, detailId = null, dragging = false;
  var OPEN = ['בתור', 'בעבודה', 'תקוע'];
  var TAG = { 'בתור': 'queue', 'בעבודה': 'work', 'תקוע': 'stuck', 'ממתין לאישור': 'review', 'הושלם': 'done' };

  function call(body) {
    var url = window.HOURS_API, options = { redirect: 'follow' };
    if (!body) url += '?key=' + encodeURIComponent(key) + '&t=' + Date.now();
    else {
      body.key = key;
      options.method = 'POST';
      options.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(function (r) { return r.json(); });
  }

  function nt(t) { return esc(t.id.replace(/^T/, '') + '. ' + t.title); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(min) { min = Math.round(min); return Math.floor(min / 60) + ':' + pad(min % 60); }
  function hrs(min) { return (min / 60).toFixed(1).replace(/\.0$/, ''); }
  function fmt(ms, o) { return new Date(ms).toLocaleString('he-IL', Object.assign({ timeZone: 'Asia/Jerusalem' }, o)); }
  function day(ms) { return fmt(ms, { day: '2-digit', month: '2-digit' }); }
  function clock(ms) { return fmt(ms, { hour: '2-digit', minute: '2-digit' }); }
  function dayKey(ms) { return fmt(ms, { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  function now() { return Date.now() + skew; }
  function ago(ms) {
    var m = Math.round((now() - ms) / 60000);
    if (m < 1) return 'עכשיו';
    if (m < 60) return 'לפני ' + m + ' דק׳';
    if (m < 1440) return 'לפני ' + Math.round(m / 60) + ' שע׳';
    return day(ms);
  }

  // Israeli week starts on Sunday, midnight Jerusalem time.
  function weekStart() {
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(now()));
    var get = function (t) { return parts.filter(function (p) { return p.type === t; })[0].value; };
    var dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    var midnight = Date.UTC(+get('year'), +get('month') - 1, +get('day'));
    return { start: midnight - dow * 86400000, dow: dow };
  }

  function liveExtra(t) {
    if (!t.active || data.state !== 'working') return 0;
    var n = data.tasks.filter(function (x) { return x.active; }).length || 1;
    return (now() - data.now) / 60000 / n;
  }
  function minutesOf(t) { return t.minutes + liveExtra(t); }
  function forecast(t) {
    var m = minutesOf(t);
    if (t.pct > 0 && t.pct < 100 && m > 0) return m * (100 - t.pct) / t.pct;
    if (t.pct === 0 && t.est) return t.est * 60;
    return null;
  }
  function atRisk(t) {
    if (!t.deadline || t.pct >= 100) return false;
    var left = t.deadline + 86400000 - now();
    return left < 0 || (left < 2 * 86400000 && t.pct < 70);
  }

  function toast(text, bad) {
    var el = $('toast');
    el.textContent = text;
    el.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.className = ''; }, bad ? 5000 : 2600);
  }

  var ERR = { empty: 'צריך לכתוב משהו', bad_deadline: 'תאריך לא תקין', bad_estimate: 'הערכת שעות לא תקינה', invalid_state: 'המשימה כבר השתנתה, הלוח התעדכן', no_task: 'המשימה לא קיימת' };
  function send(body, ok) {
    if (busy) return Promise.resolve(false);
    busy = true;
    return call(body).then(function (s) {
      if (s.error === 'unauthorized') throw new Error('unauthorized');
      if (s.tasks) render(s);
      if (s.error) { toast(ERR[s.error] || 'לא נשמר, נסה שוב', true); return false; }
      toast(ok);
      return true;
    }).catch(function (e) {
      toast(e.message === 'unauthorized' ? 'הקישור לא תקין' : 'אין חיבור, לא נשמר', true);
      return false;
    }).then(function (r) { busy = false; return r; });
  }

  function refresh() {
    if (busy || dragging || !key || document.hidden) return;
    if ($('form').open) return;
    call().then(function (s) {
      if (s.error === 'unauthorized') { $('live-text').textContent = 'הקישור לא תקין'; return; }
      if (s.tasks) render(s);
    }).catch(function () { $('live-text').textContent = data ? $('live-text').textContent : 'אין חיבור'; });
  }

  // ---------- Rendering ----------
  function render(s) {
    data = s;
    skew = s.now - Date.now();
    $('sheet-link').href = s.sheetUrl;
    renderLive();
    var tasks = s.tasks.slice().sort(function (a, b) { return a.order - b.order; });
    var waiting = tasks.filter(function (t) { return t.status === 'תקוע' || t.status === 'ממתין לאישור'; });
    var open = tasks.filter(function (t) { return t.status === 'בתור' || t.status === 'בעבודה'; });
    var done = tasks.filter(function (t) { return t.status === 'הושלם'; }).sort(function (a, b) { return b.updated - a.updated; });

    $('waiting-sec').hidden = !waiting.length;
    $('waiting-count').textContent = waiting.length;
    if (!holdsFocus('waiting')) $('waiting').innerHTML = waiting.map(waitingCard).join('');
    $('open-count').textContent = open.length;
    $('open').innerHTML = open.length ? open.map(function (t) { return card(t, true); }).join('')
      : '<p class="empty">אין משימות פתוחות. לחץ "משימה חדשה" כדי להוסיף.</p>';
    $('done-count').textContent = done.length;
    $('done').innerHTML = done.length ? done.map(function (t) { return card(t, false); }).join('') : '<p class="empty">עוד אין</p>';
    $('n-open').textContent = open.length + waiting.length;
    renderWeek();
    renderFeed();
    if (detailId && $('detail').open && !holdsFocus('detail-body')) showDetail(detailId);
  }

  function holdsFocus(id) {
    var a = document.activeElement;
    return a && a.tagName === 'TEXTAREA' && $(id).contains(a) && a.value;
  }

  function renderLive() {
    var active = data.tasks.filter(function (t) { return t.active; });
    var dot = $('dot');
    dot.className = 'dot' + (data.state === 'working' ? ' on' : data.state === 'break' ? ' pause' : '');
    if (data.state === 'working') {
      $('live-text').textContent = active.length ? 'שניר עובד עכשיו על ' + active.map(function (t) { return t.title; }).join(', ') : 'שניר בעבודה, בלי משימה פתוחה';
      $('live-sub').textContent = 'התחיל ב-' + data.startLabel + (data.breakMinutes ? ', הפסקות ' + data.breakMinutes + ' דקות' : '');
    } else if (data.state === 'break') {
      $('live-text').textContent = 'שניר בהפסקה';
      $('live-sub').textContent = 'מ-' + clock(data.breakStartedAt) + ', התחיל לעבוד ב-' + data.startLabel;
    } else {
      $('live-text').textContent = 'שניר לא בעבודה עכשיו';
      $('live-sub').textContent = data.last ? 'היום עבד ' + data.last.start + ' עד ' + data.last.end : '';
    }
  }

  function tag(t) {
    return '<span class="tag tag-' + TAG[t.status] + '">' + esc(t.status) + '</span>' + (t.active ? ' <span class="tag tag-live">עובד עכשיו</span>' : '');
  }

  function meta(t) {
    var m = minutesOf(t), parts = [];
    var over = t.est && m / 60 > t.est;
    parts.push('<span class="' + (over ? 'over' : '') + '">' + hrs(m) + (t.est ? ' מתוך ' + t.est : '') + ' שעות</span>');
    var f = forecast(t);
    if (f !== null && t.status !== 'הושלם') parts.push('<span>צפי: עוד ' + hrs(f) + ' שעות</span>');
    if (t.deadline) parts.push('<span class="' + (atRisk(t) ? 'bad' : '') + '">עד ' + day(t.deadline) + (atRisk(t) ? ', בסיכון' : '') + '</span>');
    var last = t.sessions[t.sessions.length - 1];
    if (last) parts.push('<span>עבד לאחרונה ' + ago(last.end) + '</span>');
    return '<div class="meta">' + parts.join('') + '</div>';
  }

  function progress(t) {
    return '<div class="progress"><div class="bar" role="img" aria-label="' + t.pct + ' אחוז"><span style="width:' + t.pct + '%"></span></div><span class="pct">' + t.pct + '%</span></div>';
  }

  function card(t, sortable) {
    return '<div class="card' + (t.active ? ' active' : '') + '" data-id="' + esc(t.id) + '">' +
      '<div class="card-top">' + (sortable ? '<span class="handle" aria-hidden="true">⠿</span>' : '') +
      '<p class="title" data-open="' + esc(t.id) + '">' + nt(t) + '</p>' + tag(t) + '</div>' +
      progress(t) + meta(t) + notesBlock(t) +
      '<div class="inline"><button class="btn btn-soft" data-note="' + esc(t.id) + '">הערה לשניר</button></div></div>';
  }

  // Every comment and work update of a task, newest first, opened in place on the card.
  var openNotes = {};
  function notesBlock(t) {
    var items = t.comments.map(function (c) {
      return { at: c.at, html: '<span class="who">' + esc(c.who) + '</span><br>' + esc(c.text) };
    }).concat(t.sessions.map(function (x, i) {
      return { at: x.end, html: '<span class="who">עדכון ' + (i + 1) + '</span> <span class="when">' + clock(x.start) + ' עד ' + clock(x.end) + ', ' + hm(x.minutes) + ' שעות, ' + x.from + '% עד ' + x.to + '%</span>' + (x.note ? '<br>' + esc(x.note) : '') };
    }));
    if (!items.length) return '';
    items.sort(function (a, b) { return b.at - a.at; });
    var open = openNotes[t.id];
    return '<div class="notes"><button class="link" data-notes="' + esc(t.id) + '" aria-expanded="' + !!open + '">' +
      (open ? 'סגירת הערות' : 'פתח הערות') + ' (' + items.length + ')</button>' +
      (open ? '<ul class="list notes-list">' + items.map(function (i) {
        return '<li><span class="when">' + day(i.at) + ' ' + clock(i.at) + '</span> ' + i.html + '</li>';
      }).join('') + '</ul>' : '') + '</div>';
  }

  function waitingCard(t) {
    var body = '';
    if (t.status === 'תקוע') {
      body = '<div class="ask"><b>שניר שואל:</b> ' + esc(t.question) + '</div>' +
        '<div class="inline"><textarea id="ans-' + esc(t.id) + '" rows="1" placeholder="התשובה שלך"></textarea>' +
        '<button class="btn btn-main" data-answer="' + esc(t.id) + '">שליחת תשובה</button></div>';
    } else {
      var lastNote = t.sessions.filter(function (s) { return s.note; }).pop();
      body = (lastNote ? '<div class="ask" style="background:var(--amber-soft)"><b>שניר כתב:</b> ' + esc(lastNote.note) + '</div>' : '') +
        '<div class="inline"><textarea id="ret-' + esc(t.id) + '" rows="1" placeholder="הערה, חובה אם מחזירים"></textarea>' +
        '<button class="btn btn-green" data-approve="' + esc(t.id) + '">אישור, הושלם</button>' +
        '<button class="btn btn-red" data-return="' + esc(t.id) + '">להחזיר לעבודה</button></div>';
    }
    return '<div class="card" data-id="' + esc(t.id) + '"><div class="card-top"><p class="title" data-open="' + esc(t.id) + '">' + esc(t.title) + '</p>' + tag(t) + '</div>' +
      progress(t) + meta(t) + notesBlock(t) + body + '</div>';
  }

  function renderWeek() {
    var w = weekStart(), per = {}, perDay = [0, 0, 0, 0, 0, 0, 0], total = 0, today = 0, todayKey = dayKey(now());
    data.tasks.forEach(function (t) {
      t.sessions.forEach(function (s) {
        if (s.start >= w.start) {
          per[t.id] = (per[t.id] || 0) + s.minutes;
          perDay[Math.floor((s.start - w.start) / 86400000)] += s.minutes;
          total += s.minutes;
        }
        if (dayKey(s.start) === todayKey) today += s.minutes;
      });
      var extra = t.active ? t.active.minutes + liveExtra(t) : 0;
      if (extra) { per[t.id] = (per[t.id] || 0) + extra; perDay[w.dow] += extra; total += extra; today += extra; }
    });
    $('n-today').textContent = hm(today);
    $('n-week').textContent = hm(total);
    var rows = data.tasks.filter(function (t) { return per[t.id]; }).sort(function (a, b) { return per[b.id] - per[a.id]; });
    $('week').innerHTML = rows.length ? rows.map(function (t) {
      return '<div class="week-row"><span>' + nt(t) + '</span><b>' + hm(per[t.id]) + '</b></div>';
    }).join('') + '<div class="week-row week-total"><span>סה"כ על משימות</span><b>' + hm(total) + '</b></div>' : '<p class="when" style="margin:0">עוד לא נרשמו שעות השבוע</p>';
    var max = Math.max.apply(null, perDay.concat([60]));
    var names = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
    $('days').innerHTML = perDay.map(function (m, i) {
      return '<div title="' + hm(m) + '"><i style="height:' + Math.round(m / max * 60) + 'px"></i>' + names[i] + '</div>';
    }).join('');
  }

  function renderFeed() {
    var items = [];
    data.tasks.forEach(function (t) {
      t.sessions.forEach(function (s, i) {
        items.push({ at: s.end, html: '<span class="who"><bdi>' + nt(t) + '</bdi>, עדכון ' + (i + 1) + '</span>: ' + hm(s.minutes) + ' שעות, ' + s.from + '% עד ' + s.to + '%' + (s.note ? '<br>' + esc(s.note) : '') });
      });
      t.comments.forEach(function (c) {
        items.push({ at: c.at, html: '<span class="who">' + esc(c.who) + '</span> על <bdi>' + esc(t.title) + '</bdi>: ' + esc(c.text) });
      });
    });
    items.sort(function (a, b) { return b.at - a.at; });
    $('feed').innerHTML = items.length ? items.slice(0, 8).map(function (i) {
      return '<li>' + i.html + '<br><span class="when">' + ago(i.at) + '</span></li>';
    }).join('') : '<li class="when">אין עדכונים עדיין</li>';
  }

  // ---------- Detail ----------
  function showDetail(id) {
    var t = data.tasks.filter(function (x) { return x.id === id; })[0];
    if (!t) { $('detail').close(); return; }
    detailId = id;
    var f = forecast(t);
    var html = '<div class="card-top"><h3 style="flex:1">' + nt(t) + '</h3>' + tag(t) + '</div>' +
      progress(t) +
      '<div class="stats">' +
      '<div class="stat"><b>' + hrs(minutesOf(t)) + '</b><span>שעות בפועל</span></div>' +
      '<div class="stat"><b>' + (t.est || 'אין') + '</b><span>הערכה</span></div>' +
      '<div class="stat"><b>' + (f !== null && t.status !== 'הושלם' ? hrs(f) : 'אין') + '</b><span>צפי לסיום, שעות</span></div>' +
      '<div class="stat"><b style="' + (atRisk(t) ? 'color:var(--red)' : '') + '">' + (t.deadline ? day(t.deadline) : 'אין') + '</b><span>דדליין</span></div></div>';
    if (t.desc) html += '<p class="desc">' + esc(t.desc) + '</p>';
    if (t.status === 'תקוע') html += '<div class="ask"><b>שניר שואל:</b> ' + esc(t.question) + '</div>';
    html += '<h2 style="margin-top:6px">הערות</h2>' + (t.comments.length ? '<ul class="list">' + t.comments.slice().reverse().map(function (c) {
      return '<li><span class="who">' + esc(c.who) + '</span> <span class="when">' + day(c.at) + ' ' + clock(c.at) + '</span><br>' + esc(c.text) + '</li>';
    }).join('') + '</ul>' : '<p class="when" style="margin:0">אין הערות</p>') +
      '<div class="inline"><textarea id="d-comment" rows="1" placeholder="' + (t.status === 'תקוע' ? 'התשובה שלך לשניר' : 'הערה לשניר') + '"></textarea>' +
      '<button class="btn btn-main" data-' + (t.status === 'תקוע' ? 'answer-d' : 'comment') + '="' + esc(t.id) + '">שליחה</button></div>';
    html += '<h2 style="margin-top:6px">מתי עבד ומה עשה</h2>' + (t.sessions.length ? '<ul class="list">' + t.sessions.map(function (s, i) { s.n = i + 1; return s; }).slice().reverse().map(function (s) {
      return '<li><span class="who">עדכון ' + s.n + ': ' + day(s.start) + ', ' + clock(s.start) + ' עד ' + clock(s.end) + '</span> <span class="when">' + hm(s.minutes) + ' שעות, ' + s.from + '% עד ' + s.to + '%</span>' + (s.note ? '<br>' + esc(s.note) : '') + '</li>';
    }).join('') + '</ul>' : '<p class="when" style="margin:0">עוד לא עבד על המשימה</p>');
    html += '<div class="actions" style="margin-top:6px">' +
      (t.status === 'ממתין לאישור' ? '<button class="btn btn-green" data-approve="' + esc(t.id) + '">אישור, הושלם</button>' : '') +
      (t.status === 'הושלם' ? '<button class="btn btn-soft" data-reopen="' + esc(t.id) + '">לפתוח מחדש</button>' : '') +
      '<button class="btn btn-soft" data-edit="' + esc(t.id) + '">עריכה</button>' +
      '<button class="btn btn-red" data-delete="' + esc(t.id) + '">מחיקה</button>' +
      '<button class="btn btn-soft" data-close>סגירה</button></div>';
    $('detail-body').innerHTML = html;
    if (!$('detail').open) $('detail').showModal();
  }

  // ---------- Form ----------
  function openForm(t) {
    editing = t ? t.id : null;
    $('form-title').textContent = t ? 'עריכת משימה' : 'משימה חדשה';
    $('f-title').value = t ? t.title : '';
    $('f-desc').value = t ? t.desc : '';
    $('f-est').value = t && t.est !== '' && t.est != null ? t.est : '';
    $('f-deadline').value = t && t.deadline ? new Date(t.deadline).toISOString().slice(0, 10) : '';
    $('f-err').textContent = '';
    if ($('detail').open) $('detail').close();
    $('form').showModal();
    $('f-title').focus();
  }
  $('add').addEventListener('click', function () { openForm(null); });
  $('f-cancel').addEventListener('click', function () { $('form').close(); });
  $('form-el').addEventListener('submit', function (e) {
    e.preventDefault();
    var task = { title: $('f-title').value.trim(), desc: $('f-desc').value.trim(), est: $('f-est').value, deadline: $('f-deadline').value };
    if (!task.title) { $('f-err').textContent = 'צריך לכתוב מה המשימה'; return; }
    $('f-save').disabled = true;
    var body = editing ? { action: 'task_edit', id: editing, task: task } : { action: 'task_add', task: task };
    send(body, editing ? 'המשימה עודכנה' : 'המשימה נוספה, שניר קיבל מייל').then(function (ok) {
      $('f-save').disabled = false;
      if (ok) $('form').close();
    });
  });

  // ---------- Clicks ----------
  document.addEventListener('click', function (e) {
    var tn = e.target.closest('[data-notes]');
    if (tn) { var id = tn.getAttribute('data-notes'); openNotes[id] = !openNotes[id]; render(data); return; }
    var n = e.target.closest('[data-note]');
    if (n) { showDetail(n.getAttribute('data-note')); var box = $('d-comment'); if (box) { box.scrollIntoView({ block: 'center' }); box.focus(); } return; }
    var b = e.target.closest('[data-open],[data-answer],[data-answer-d],[data-approve],[data-return],[data-comment],[data-edit],[data-delete],[data-close],[data-reopen]');
    if (!b) return;
    var get = function (n) { return b.getAttribute(n); };
    if (b.hasAttribute('data-open')) return showDetail(get('data-open'));
    if (b.hasAttribute('data-close')) { detailId = null; return $('detail').close(); }
    if (busy) return;
    if (b.hasAttribute('data-answer') || b.hasAttribute('data-answer-d')) {
      var id = get('data-answer') || get('data-answer-d');
      var box = b.hasAttribute('data-answer') ? $('ans-' + id) : $('d-comment');
      if (!box.value.trim()) return toast('כתוב תשובה');
      return send({ action: 'answer', id: id, text: box.value.trim() }, 'התשובה נשלחה לשניר');
    }
    if (b.hasAttribute('data-approve')) {
      var note = $('ret-' + get('data-approve'));
      return send({ action: 'approve', id: get('data-approve'), text: note ? note.value.trim() : '' }, 'אושר');
    }
    if (b.hasAttribute('data-return')) {
      var r = $('ret-' + get('data-return'));
      if (!r.value.trim()) { r.focus(); return toast('כתוב מה עוד צריך'); }
      return send({ action: 'return', id: get('data-return'), text: r.value.trim() }, 'הוחזר לשניר');
    }
    if (b.hasAttribute('data-reopen')) {
      var why = $('d-comment').value.trim();
      if (!why) { $('d-comment').focus(); return toast('כתוב בהערה למה פותחים מחדש'); }
      return send({ action: 'return', id: get('data-reopen'), text: why }, 'נפתח מחדש');
    }
    if (b.hasAttribute('data-comment')) {
      var c = $('d-comment').value.trim();
      if (!c) return;
      return send({ action: 'comment', id: get('data-comment'), text: c }, 'ההערה נשלחה');
    }
    if (b.hasAttribute('data-edit')) return openForm(data.tasks.filter(function (t) { return t.id === get('data-edit'); })[0]);
    if (b.hasAttribute('data-delete')) {
      if (b.getAttribute('data-sure') !== '1') { b.setAttribute('data-sure', '1'); b.textContent = 'בטוח? למחוק'; return; }
      send({ action: 'task_delete', id: get('data-delete') }, 'נמחקה').then(function (ok) { if (ok) { detailId = null; $('detail').close(); } });
    }
  });
  $('detail').addEventListener('close', function () { detailId = null; });

  // ---------- Drag to set priority ----------
  if (window.Sortable) {
    Sortable.create($('open'), {
      handle: '.handle', animation: 150, delay: 120, delayOnTouchOnly: true,
      onStart: function () { dragging = true; },
      onEnd: function (ev) {
        dragging = false;
        if (ev.oldIndex === ev.newIndex) return;
        var order = Array.prototype.map.call($('open').querySelectorAll('.card'), function (c) { return c.getAttribute('data-id'); });
        var rest = data.tasks.filter(function (t) { return order.indexOf(t.id) < 0; }).sort(function (a, b) { return a.order - b.order; }).map(function (t) { return t.id; });
        send({ action: 'reorder', order: order.concat(rest) }, 'הסדר נשמר');
      }
    });
  }

  if (!key) {
    $('live-text').textContent = 'חסר קישור. צריך לפתוח את הקישור המלא שקיבלת';
    $('add').disabled = true;
    return;
  }
  setInterval(function () { if (data) { renderLive(); renderWeek(); } }, 30000);
  setInterval(refresh, 20000);
  document.addEventListener('visibilitychange', refresh);
  refresh();
})();
