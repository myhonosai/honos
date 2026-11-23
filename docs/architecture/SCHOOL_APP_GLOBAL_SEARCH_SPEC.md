# School app: close Menu on outside click, and one search bar on every page

Owner ask (David, 2026-11-21, live test of main 981feb8): "make so i can click outside of box to return to working
screen. also need main search bar on top to search everything from contact to menu." Reference: his Manus CRM top
search (studied read only, layout only, no personal data copied): a "Search contacts, classes, leads, pages…" box in the
top bar, Ctrl+K to open, a pop-up list grouped Contacts / Classes / Leads / Pages, arrow keys + Enter, Esc to close.

## 1. Menu closes on an outside click

The Menu pop-up (Modern and Big Button) already had a backdrop, but it was hidden on screens 1100px and wider, so a click
beside the box did nothing. The backdrop now shows whenever the Menu pop-up is open, dims the page, and closes the Menu
when clicked. Clicks inside the box (including its empty space) do not close it. Esc and the X keep working. Classic's
left sidebar is unchanged.

## 2. Search bar in the top bar

- Every school page shows a search field in the top bar ("Search contacts, pages…", Ctrl+K / ⌘K hint). Phones show a
  search icon that opens the same pop-up.
- Clicking it, or Ctrl+K / ⌘K anywhere, opens the search pop-up. A click outside the pop-up or Esc closes it.
- Results, in groups:
  - **Pages**: every menu page and tab (title, with "Section · Page" under it), matched on page, tab and section names in
    the viewer's language. Works with no network. Empty query lists the main pages.
  - **Contacts**: the existing people read (`GET …/schools/{school}/people?query=`), first 6. Opens
    `/staff/people?person=<id>` (the contacts thread adds the reader for that link; until then it opens the list).
  - **Leads, Classes, Programs, Curricula**: the existing staff search read (`GET …/schools/{school}/search`, types
    `LEAD,CLASS_SESSION,PROGRAM,CURRICULUM`), validated with `safeSearchResults`; opens its fixed record route.
- Remote groups run only for a verified school, after 2+ characters, debounced 250 ms; each new keystroke aborts the
  previous reads. A refused or failed group shows one quiet line ("Contacts could not be searched") and the other groups
  still show.
- Results carry `data-shell-private`, and a session end or school change closes the pop-up and clears the results.

## Security boundary

Read only. No new endpoint, migration, command or permission. Both reads re-authorize the exact school on the server;
the browser sends only the verified selection and the typed text. The contact link carries only the person id.

## Tests

- Pure page matcher: matches page/tab/section names in en/ko/es, hides hidden routes, adds the verified prefill only for
  scoped routes.
- Frame: backdrop rendered for the Menu pop-up at all widths and closes on click; the search slot is rendered in the top bar.
- Palette (jsdom): opens on Ctrl+K, groups results, arrow + Enter navigation, outside click and Esc close, no remote read
  without a verified school or under 2 characters, a failed group does not hide the others, a school change clears.
