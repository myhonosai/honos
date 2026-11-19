# School app screensaver (replaces "School hidden while away")

Owner request (David, 2026-11-16): remove "School hidden while away" and give the
school app a screensaver instead.

## Problem

The school app shell treated blur, a hidden tab and page hide as privacy events. Each
one dropped the verified school (`CONCEALED`), and every page then showed "Choose a
school…" until the viewer pressed **Show school**. On a phone that happens every time
the app goes to the background, so staff had to re-open the school constantly.

## Behaviour

1. **Away events no longer drop the school.** Blur, a hidden tab and page hide keep
   the verified school and every page's data in place.
2. **Screensaver.** The shell covers the whole app with a screensaver (HON mark, school
   name, current time, "Tap anywhere to continue") when:
   - the tab or app is hidden (phone backgrounded, tab switched) or the page is hidden
     (`pagehide`, including the back/forward cache), or
   - nobody has touched, clicked, typed or scrolled for 5 minutes.
   It renders synchronously on hide, so the app switcher and anyone glancing at the
   screen see the screensaver, not school records. The page behind it is inert.
3. **Coming back.** A tap, click or key press dismisses it and shows the same page with
   the same school, no re-choosing. If the app was hidden for less than 30 seconds the
   screensaver lifts by itself on return.
4. **Quiet re-check.** Every time the screensaver lifts, the shell re-checks the signed-in
   identity and the exact school in the background without leaving the page. If the
   session ended, the identity changed or access was removed, the shell moves to that
   state (sign in again / no access) exactly as before. A network failure keeps the page.

## Kept security behaviour (unchanged)

- Session end (`hon:session-invalidated`, any 401) still clears the school and every
  page's data, and asks the viewer to sign in.
- Switching school still clears every page and reloads (`hon:school-context-changed`).
- Pages keep authorizing the exact school on every API call (server-side).
- `onShellPrivacyEvent` now listens to those two security events only (always, even
  when a page passes no extras), so every shell page keeps clearing on them.

## Scope

- In: school shell, `onShellPrivacyEvent` (used by ~35 school pages incl. Conversations,
  Family messages, Home, People, Leads), Ask HON conversation panel, shell copy (en/ko/es).
- Follow-up slice: older staff workbenches that still hide their own content on blur
  (CRM lead memberships, membership dates/activation, planned absences, lead intake
  monitor, plan catalog, founder setup, operations dashboard, CRM leads workbench).
- Out: HQ pages, parent/family app, kiosk lock (kiosk keeps locking on hide).
- No migration, no API or database change.

## Plan

1. Tests first: privacy helper ignores away events; controller `recheck()`;
   `ScreensaverController` (hidden, brief return, idle, dismiss); frame renders the
   screensaver and makes the app inert.
2. `privacy.ts` security-events-only; `SchoolEntryController.recheck()`.
3. `school-shell/screensaver.ts` controller + frame overlay + CSS + copy.
4. Shell wires it (flushSync on hide), Ask HON panel stops concealing on away.
5. Full web test + typecheck + build, screenshots at phone and desktop width.
