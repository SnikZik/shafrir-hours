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

  function call(method, action, note) {
    var url = window.HOURS_API;
    var options = { redirect: 'follow' };
    if (method === 'GET') {
      url += '?key=' + encodeURIComponent(key) + '&t=' + Date.now();
    } else {
      options.method = 'POST';
      options.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
      options.body = JSON.stringify({ key: key, action: action, note: note || '' });
    }
    return fetch(url, options).then(function (r) { return r.json(); });
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function duration(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }

  function hoursText(minutes) {
    return Math.floor(minutes / 60) + ':' + pad(minutes % 60);
  }

  function tick() {
    if (!current) return;
    var now = Date.now() + clockSkew;
    if (current.state === 'working' && current.startedAt) {
      el.clock.textContent = duration(now - current.startedAt - current.breakMinutes * 60000);
    } else if (current.state === 'break') {
      el.clock.textContent = duration(now - current.breakStartedAt);
    }
  }

  function render(s) {
    current = s;
    clockSkew = s.now - Date.now();
    var isOff = s.state === 'off';
    var isBreak = s.state === 'break';

    el.start.disabled = !isOff;
    el.pause.disabled = isOff;
    el.end.disabled = isOff;
    el.pause.textContent = isBreak ? 'חזרתי מהפסקה' : 'יצאתי להפסקה';

    if (isBreak) {
      el.status.textContent = 'בהפסקה';
      el.detail.textContent = 'התחלת ב ' + s.startLabel;
    } else if (!isOff) {
      el.status.textContent = 'בעבודה';
      el.detail.textContent = 'התחלת ב ' + s.startLabel + (s.breakMinutes ? ', הפסקות ' + s.breakMinutes + ' דקות' : '');
    } else if (s.last) {
      el.status.textContent = 'סיימת להיום';
      el.clock.textContent = hoursText(s.last.netMinutes);
      el.detail.textContent = s.last.start + ' עד ' + s.last.end + (s.last.breakMinutes ? ', הפסקות ' + s.last.breakMinutes + ' דקות' : '');
    } else {
      el.status.textContent = 'לא בעבודה';
      el.clock.textContent = '0:00';
      el.detail.textContent = '';
    }
    tick();
  }

  function toast(text, isError) {
    el.toast.textContent = text;
    el.toast.className = 'show' + (isError ? ' err' : '');
    clearTimeout(toast.timer);
    if (!isError) toast.timer = setTimeout(function () { el.toast.className = ''; el.toast.textContent = ''; }, 3500);
  }

  // Notes before a break or the end of the day: typed, or dictated through the browser's speech recognition.
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognition = null;
  var reportAction = null;
  var micStatus = $('report-mic-status');

  function stopMic() {
    if (recognition) { recognition.onend = null; recognition.stop(); recognition = null; }
    $('report-mic').classList.remove('on');
    $('report-mic').textContent = 'הקלטה קולית';
  }

  function startMic() {
    var box = $('report-text');
    var base = box.value ? box.value.replace(/\s*$/, ' ') : '';
    recognition = new SpeechRecognition();
    recognition.lang = 'he-IL';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = function (e) {
      var finalText = '', interim = '';
      for (var i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      box.value = base + finalText + interim;
    };
    recognition.onerror = function (e) {
      micStatus.textContent = e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'אין הרשאה למיקרופון. אפשר להכתיב עם המיקרופון במקלדת'
        : 'ההקלטה נעצרה, אפשר לנסות שוב';
    };
    recognition.onend = function () { stopMic(); };
    recognition.start();
    $('report-mic').classList.add('on');
    $('report-mic').textContent = 'עצירת הקלטה';
    micStatus.textContent = 'מקליט, מדבר ונכתב';
  }

  function openReport(action) {
    reportAction = action;
    $('report-title').textContent = action === 'end' ? 'סיום יום' : 'יציאה להפסקה';
    $('report-ok').textContent = action === 'end' ? 'סיימתי לעבוד' : 'יצאתי להפסקה';
    $('report-hint').textContent = action === 'end' ? 'מה עשית היום? כמה מילים, לא חובה' : 'למה יצאת להפסקה? כמה מילים, לא חובה';
    $('report-text').value = '';
    micStatus.textContent = SpeechRecognition ? '' : 'אפשר להכתיב עם המיקרופון במקלדת';
    $('report-mic').hidden = !SpeechRecognition;
    $('report').hidden = false;
    $('report-text').focus();
  }

  function closeReport() {
    stopMic();
    $('report').hidden = true;
  }

  function setBusy(on) {
    busy = on;
    document.body.classList.toggle('busy', on);
  }

  function press(action, doneText, note) {
    if (busy) return;
    setBusy(true);
    toast('שולח');
    call('POST', action, note).then(function (s) {
      if (s.error === 'unauthorized') throw new Error('unauthorized');
      if (s.state) render(s);
      if (s.error === 'invalid_state') toast('המצב כבר התעדכן, בדוק שזה נכון');
      else if (s.error) toast('לא נשמר, נסה שוב', true);
      else toast(doneText + ' ' + new Date(s.now).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' }));
    }).catch(function (e) {
      toast(e.message === 'unauthorized' ? 'הקישור לא תקין' : 'לא נשמר, בדוק אינטרנט ונסה שוב', true);
    }).then(function () { setBusy(false); });
  }

  function refresh() {
    if (busy || !key) return;
    call('GET').then(function (s) {
      if (s.error === 'unauthorized') { el.status.textContent = 'הקישור לא תקין'; return; }
      if (s.state) { render(s); if (el.toast.classList.contains('err')) { el.toast.className = ''; el.toast.textContent = ''; } }
    }).catch(function () {
      if (!current) el.status.textContent = 'אין חיבור';
      toast('אין חיבור לאינטרנט. שום דבר לא נשמר עד שיחזור', true);
    });
  }

  $('report-mic').addEventListener('click', function () {
    if (recognition) stopMic();
    else {
      try { startMic(); } catch (e) { stopMic(); micStatus.textContent = 'ההקלטה לא זמינה, אפשר להכתיב עם המיקרופון במקלדת'; }
    }
  });
  $('report-cancel').addEventListener('click', closeReport);
  $('report-ok').addEventListener('click', function () {
    var note = $('report-text').value.trim();
    var action = reportAction;
    closeReport();
    press(action, action === 'end' ? 'נרשם סיום' : 'נרשמה הפסקה', note);
  });
  el.start.addEventListener('click', function () { press('start', 'נרשמה התחלה'); });
  el.pause.addEventListener('click', function () {
    if (current && current.state === 'break') press('break_end', 'נרשמה חזרה');
    else openReport('break_start');
  });
  el.end.addEventListener('click', function () {
    openReport('end');
  });

  if (!key) {
    el.status.textContent = 'חסר קישור התקנה';
    el.detail.textContent = 'צריך לפתוח את קישור ההתקנה המלא';
    return;
  }

  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  refresh();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
