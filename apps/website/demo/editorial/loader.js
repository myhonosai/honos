// Demo B loading screen. Downloads what the story needs before the curtain lifts, so scrolling never stalls:
// the fonts, the first paintings and the whole door film (kept in memory, which also makes scrubbing instant).
// Shows real progress. Lifts after at most 12 seconds even on a slow connection; the rest then streams in.
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

  var images = ['../shared/assets/story-door.webp', '../shared/assets/story-class.webp', '../shared/assets/story-master.webp',
    '../shared/assets/story-belt.webp', '../shared/assets/ai-kai-illustrated.webp'];
  var lines = ['Lighting the lanterns', 'Opening the dojo', 'Waking the AI team', 'Ready'];

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

  // Images
  var left = images.length;
  images.forEach(function (src) {
    var im = new Image();
    im.onload = im.onerror = function () { left--; got.img = 1 - left / images.length; };
    im.src = src;
  });

  // Fonts
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { got.font = 1; });
  else got.font = 1;

  // Film: fetch the whole file with progress, then play it from memory.
  function useUrl(u) { if (film) { film.src = u; film.load(); } }
  if (film && filmUrl && window.fetch && window.ReadableStream) {
    fetch(filmUrl).then(function (res) {
      if (!res.ok || !res.body) throw new Error('film ' + res.status);
      var total = +res.headers.get('Content-Length') || 0;
      var reader = res.body.getReader(), chunks = [], n = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          chunks.push(r.value); n += r.value.length;
          if (total) got.film = Math.min(.99, n / total);
          return pump();
        });
      }
      return pump().then(function () {
        useUrl(URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' })));
        got.film = 1;
      });
    }).catch(function () { useUrl(filmUrl); got.film = 1; });
  } else {
    if (film && filmUrl) useUrl(filmUrl);
    got.film = 1;
  }

  setTimeout(function () {
    if (!done) { got.film = got.img = got.font = 1; }
  }, 12000);
  requestAnimationFrame(tick);
})();
