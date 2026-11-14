// Desktop only: Shafrir's photo, eyes and head follow the mouse. Shared by the app and the board.
// Eye positions are measured on shafrir.jpg (280x280).
(function () {
  var box = document.getElementById('watcher');
  if (!box || !window.matchMedia('(min-width: ' + (box.getAttribute('data-min') || 1000) + 'px) and (pointer: fine)').matches) return;
  box.innerHTML = '<div class="face"><div class="tilt"><img src="shafrir.jpg" alt="">' +
    '<span class="eye" style="left:97px;top:109px;width:25px;height:8px"><i></i></span>' +
    '<span class="eye" style="left:158px;top:122px;width:22px;height:8px;transform:rotate(6deg)"><i></i></span>' +
    '</div></div>' + (box.getAttribute('data-caption') ? '<p></p>' : '');
  if (box.getAttribute('data-caption')) box.querySelector('p').textContent = box.getAttribute('data-caption');
  box.hidden = false;
  var tilt = box.querySelector('.tilt');
  var eyes = Array.prototype.slice.call(box.querySelectorAll('.eye'));
  var frame = 0, mx = 0, my = 0;
  function move() {
    frame = 0;
    var r = tilt.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height * 0.42;
    var nx = Math.max(-1, Math.min(1, (mx - cx) / (innerWidth * 0.6)));
    var ny = Math.max(-1, Math.min(1, (my - cy) / (innerHeight * 0.6)));
    tilt.style.transform = 'rotateY(' + (nx * 14).toFixed(1) + 'deg) rotateX(' + (-ny * 10).toFixed(1) + 'deg)';
    eyes.forEach(function (e) {
      var b = e.getBoundingClientRect();
      var dx = mx - (b.left + b.width / 2), dy = my - (b.top + b.height / 2);
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      var k = Math.min(1, d / 200);
      var px = dx / d * k * (e.offsetWidth / 2 - 4), py = dy / d * k * (e.offsetHeight / 2 - 2);
      e.firstChild.style.transform = 'translate(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px)';
    });
  }
  document.addEventListener('mousemove', function (ev) {
    mx = ev.clientX; my = ev.clientY;
    if (!frame) frame = requestAnimationFrame(move);
  });
})();
