// Shared behaviour for the design demos: yearly/monthly pricing switch and reveal-on-scroll.
// Demo only: not part of the built site (scripts/build.mjs copies src/ only).
(function () {
  // Pricing switch (same behaviour as PR #510: yearly first, works without JS by showing yearly).
  document.querySelectorAll('[data-billing]').forEach(function (root) {
    var plans = root.querySelector('.plans');
    root.querySelectorAll('button[data-period]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = btn.getAttribute('data-period');
        plans.setAttribute('data-period', p);
        root.querySelectorAll('button[data-period]').forEach(function (b) {
          b.setAttribute('aria-pressed', String(b === btn));
        });
      });
    });
  });

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var items = document.querySelectorAll('[data-reveal]');
  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.15 });
    items.forEach(function (el) { io.observe(el); });
  }

  // Scroll progress per [data-progress] element (0 when its top hits the bottom of the screen, 1 when centred).
  var tracked = document.querySelectorAll('[data-progress]');
  if (!reduce && tracked.length) {
    var tick = function () {
      var vh = window.innerHeight;
      tracked.forEach(function (el) {
        var r = el.getBoundingClientRect();
        var p = (vh - r.top) / (vh * 0.9);
        el.style.setProperty('--p', Math.max(0, Math.min(1, p)).toFixed(3));
      });
    };
    window.addEventListener('scroll', tick, { passive: true });
    window.addEventListener('resize', tick);
    tick();
  } else {
    tracked.forEach(function (el) { el.style.setProperty('--p', '1'); });
  }

  // Highlight the nav item for the section in view ([data-nav] links pointing at #ids).
  var links = document.querySelectorAll('[data-nav] a[href^="#"]');
  if (links.length && 'IntersectionObserver' in window) {
    var map = {};
    links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('on'); });
        var a = map[e.target.id];
        if (a) a.classList.add('on');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(map).forEach(function (id) { var s = document.getElementById(id); if (s) spy.observe(s); });
  }
})();
