// Home page scroll story: each [data-scene] is a tall section with a sticky stage inside.
// Its progress --p runs 0 -> 1 while the stage is pinned; scene handlers turn that into motion.
// Reduced motion (or no JS) shows every scene in its finished state.
(function () {
  var root = document.documentElement;
  // boot.js already chose html.story (motion) or html.still (reduced motion: every scene shown finished).
  if (!root.classList.contains('story')) return;

  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var seg = function (p, a, b) { return clamp((p - a) / (b - a), 0, 1); };
  var ease = function (t) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };

  // Star field for the opening "travel" (stars rush past as you scroll).
  var warp = document.querySelector('.warp');
  var stars = [];
  if (warp) {
    for (var i = 0; i < 150; i++) {
      var s = document.createElement(i % 9 === 0 ? 'i' : 'b');
      var a = Math.random() * Math.PI * 2, r = Math.pow(Math.random(), .7) * 70;
      var st = { el: s, x: Math.cos(a) * r, y: Math.sin(a) * r * .7, z: .3 + Math.random() * 1.7 };
      s.style.left = (50 + st.x) + '%'; s.style.top = (50 + st.y) + '%';
      if (s.tagName === 'I') s.style.setProperty('--s', (8 + Math.random() * 14).toFixed(0) + 'px');
      warp.appendChild(s); stars.push(st);
    }
  }

  // Word-by-word reveal: wrap each word of [data-words] in a span.
  document.querySelectorAll('[data-words]').forEach(function (el) {
    el.innerHTML = el.textContent.trim().split(/\s+/).map(function (w) { return '<span class="w">' + w + '</span>'; }).join(' ');
  });

  var scenes = [].slice.call(document.querySelectorAll('[data-scene]'));
  var flows = [].slice.call(document.querySelectorAll('[data-flow]'));
  var bar = document.querySelector('.journey i');

  var handlers = {
    sky: function (el, p) {
      var t = ease(p);
      stars.forEach(function (st) {
        var k = 1 + t * 5 * st.z;
        st.el.style.transform = 'translate(' + (st.x * (k - 1) * 9) + 'px,' + (st.y * (k - 1) * 9) + 'px) scale(' + (1 + t * st.z * 1.6) + ')';
        st.el.style.opacity = (1 - seg(p, .55, 1)).toFixed(2);
      });
      el.style.setProperty('--fade', (1 - seg(p, 0, .45)).toFixed(3));
      el.style.setProperty('--zoom', (1 + t * .5).toFixed(3));
      el.style.setProperty('--portal', seg(p, .35, 1).toFixed(3));
    },
    door: function (el, p) {
      // Walk up to the doors, they open, and you pass through into the class.
      el.style.setProperty('--near', (1 + ease(seg(p, 0, .3)) * .18).toFixed(3));
      el.style.setProperty('--open', ease(seg(p, .2, .65)).toFixed(3));
      el.style.setProperty('--intro', (1 - seg(p, .1, .25)).toFixed(3));
      el.style.setProperty('--zoom', (1.3 - ease(seg(p, .25, .85)) * .3).toFixed(3));
      el.style.setProperty('--cap', seg(p, .7, .9).toFixed(3));
      var v = el.querySelector('.film');
      if (v && v.readyState >= 1 && v.duration) {
        if (!el.classList.contains('has-film')) el.classList.add('has-film');
        var t = seg(p, 0, .72) * (v.duration - .05);
        if (Math.abs(v.currentTime - t) > .01) v.currentTime = t;
      }
    },
    team: function (el, p) {
      var track = el.querySelector('.track-team');
      var max = track.scrollWidth - el.clientWidth + 32;
      track.style.transform = 'translateX(' + (-max * ease(seg(p, .05, .95))) + 'px)';
      var mid = window.innerWidth / 2;
      track.querySelectorAll('.col').forEach(function (c) {
        var r = c.getBoundingClientRect();
        var d = clamp(1 - Math.abs(r.left + r.width / 2 - mid) / (window.innerWidth * .6), 0, 1);
        c.style.setProperty('--near', d.toFixed(3));
      });
    },
    chapters: function (el, p) {
      var n = el.querySelectorAll('.step').length;
      var f = p * n;
      el.querySelectorAll('.step').forEach(function (s, i) {
        var local = clamp(f - i, 0, 1);
        var on = (f >= i && f < i + 1) || (i === n - 1 && f >= n - 1);
        s.classList.toggle('on', on);
        s.style.setProperty('--l', local.toFixed(3));
      });
      var k = Math.min(n - 1, Math.floor(f));
      el.querySelectorAll('.shot').forEach(function (s, i) {
        s.classList.toggle('on', i === k);
        s.classList.toggle('past', i < k);
      });
      var dots = el.querySelectorAll('.toc a');
      dots.forEach(function (a, i) { a.classList.toggle('on', Math.min(n - 1, Math.floor(f)) === i); });
    },
    close: function (el, p) {
      el.style.setProperty('--zoom', (1.3 - ease(p) * .3).toFixed(3));
      el.style.setProperty('--rise', seg(p, .15, .6).toFixed(3));
    }
  };

  function frame() {
    var vh = window.innerHeight;
    scenes.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.bottom < -vh || r.top > vh * 2) return;
      var p = clamp(-r.top / Math.max(1, r.height - vh), 0, 1);
      el.style.setProperty('--p', p.toFixed(4));
      var h = handlers[el.getAttribute('data-scene')];
      if (h) h(el, p);
    });
    // Elements that react as they pass through the screen (not pinned).
    flows.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var p = clamp((vh - r.top) / (vh * .8 + r.height * .4), 0, 1);
      el.style.setProperty('--p', p.toFixed(4));
      if (el.hasAttribute('data-words')) {
        var ws = el.querySelectorAll('.w'), n = ws.length;
        ws.forEach(function (w, i) { w.style.opacity = (.12 + .88 * clamp(p * 1.35 * n - i, 0, 1)).toFixed(2); });
      }
      el.querySelectorAll('[data-count]').forEach(function (c) {
        var to = +c.getAttribute('data-count'), v = Math.round(to * ease(clamp(p * 1.4, 0, 1)));
        c.textContent = '$' + v.toLocaleString('en-US');
      });
    });
    var max = document.documentElement.scrollHeight - vh;
    if (bar) bar.style.transform = 'scaleX(' + clamp(window.scrollY / Math.max(1, max), 0, 1).toFixed(4) + ')';
    ticking = false;
  }
  var ticking = false;
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  var film = document.querySelector('.film');
  if (film) { film.addEventListener('loadedmetadata', onScroll); film.addEventListener('loadeddata', onScroll); }
  frame();
})();
