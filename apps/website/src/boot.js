// Runs in <head> before the page paints (a file, not inline, so the site's Content-Security-Policy holds).
// Decides whether the scroll story animates (html.story) or shows every scene finished (html.still, for
// reduced motion), and shows the loading screen (html.loading) until loader.js lifts it.
(function () {
  var root = document.documentElement;
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add(still ? 'still' : 'story', 'loading');
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  // Safety net: never leave the page covered if loader.js fails to arrive.
  setTimeout(function () { root.classList.remove('loading'); }, 15000);
})();
