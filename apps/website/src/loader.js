// Loading screen: downloads what the story needs before the curtain lifts, so scrolling never stalls:
// the fonts, the first paintings and the door film. Shows real progress and lifts after at most
// 12 seconds even on a slow connection; the rest then streams in. The film is fetched once to warm the
// browser cache and then played from its own address (the Content-Security-Policy allows media from this site only).
(function () {
  var root = document.documentElement;
  var screen = document.getElementById('loader');
  if (!screen) return;
  var bar = screen.querySelector('.ld-bar i');
  var pct = screen.querySelector('.ld-pct');
  var line = screen.querySelector('.ld-line');
  var film = document.querySelector('.film');
  var phone = window.matchMedia('(max-width: 860px)').matches;
  var filmUrl = film ? film.getAttribute(phone ? 'data-src-phone' : 'data-src') : null;
  var size = phone ? '800' : '1344';
  var images = ['/assets/story-door-' + size + '.webp', '/assets/story-class-' + size + '.webp',
    '/assets/story-master-' + (phone ? '600' : '880') + '.webp', '/assets/story-belt-' + size + '.webp'];
  var LINES = {
    en: ['Lighting the lanterns', 'Opening the dojo', 'Waking the AI team', 'Ready'],
    ko: ['등불을 밝히는 중', '도장 문을 여는 중', 'AI 팀을 깨우는 중', '준비 완료'],
    es: ['Encendiendo las linternas', 'Abriendo el dojo', 'Despertando al equipo de IA', 'Listo']
  };
  var lines = LINES[root.lang] || LINES.en;

  // Progress: the film counts for 70%, images 20%, fonts 10%.
  var got = { film: 0, img: 0, font: 0 };
  var shown = 0, done = false, start = Date.now();
  function target() { return got.film * 70 + got.img * 20 + got.font * 10; }
  function tick() {
    var t = target();
    shown += (t - shown) * 0.12;
    if (t - shown < .5) shown = t;
    var v = Math.min(100, Math.round(shown));
    if (bar) bar.style.transform = 'scaleX(' + (v / 100) + ')';
    if (pct) pct.textContent = v + '%';
    if (line) line.textContent = lines[Math.min(lines.length - 1, Math.floor(v / 34))];
    if (v >= 100 && Date.now() - start > 900) return finish();
    if (!done) requestAnimationFrame(tick);
  }
  function finish() {
    if (done) return;
    done = true;
    if (bar) bar.style.transform = 'scaleX(1)';
    if (pct) pct.textContent = '100%';
    if (line) line.textContent = lines[lines.length - 1];
    setTimeout(function () {
      root.classList.remove('loading');
      screen.classList.add('gone');
      setTimeout(function () { screen.remove(); }, 1200);
      window.dispatchEvent(new Event('scroll'));
    }, 250);
  }

  var left = images.length;
  images.forEach(function (src) {
    var im = new Image();
    im.onload = im.onerror = function () { left--; got.img = 1 - left / images.length; };
    im.src = src;
  });

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { got.font = 1; });
  else got.font = 1;

  function useFilm() { if (film && filmUrl) { film.src = filmUrl; film.load(); } got.film = 1; }
  if (root.classList.contains('still') || !film || !filmUrl) {
    got.film = 1; // no film needed when motion is reduced
  } else if (window.fetch && window.ReadableStream) {
    fetch(filmUrl).then(function (res) {
      if (!res.ok || !res.body) throw new Error('film ' + res.status);
      var total = +res.headers.get('Content-Length') || 0;
      var reader = res.body.getReader(), n = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          n += r.value.length;
          if (total) got.film = Math.min(.99, n / total);
          return pump();
        });
      }
      return pump();
    }).then(useFilm, useFilm);
  } else {
    useFilm();
  }

  setTimeout(function () { if (!done) { got.film = got.img = got.font = 1; if (film && !film.src) useFilm(); } }, 12000);
  requestAnimationFrame(tick);
})();
