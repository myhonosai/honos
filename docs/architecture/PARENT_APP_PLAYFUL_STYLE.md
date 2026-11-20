# HON Family app: playful style, streak and journey recommendations

Status: spec (owner GO 2026-11-20). Preview: `/mnt/project-files/parent-app/playful-preview/`.

## Owner decisions (2026-11-20)
- GO on the playful look shown in the preview. Keep the five tabs (Home, Schedule, Eian, Messages, More), the seven More areas in their order, and every existing flow and guard.
- Weekly attendance streak in the Home top bar: YES.
- "Ask Eian about this" on announcements: NO.
- Journey recommendations may point to programs, camps, events and gear (Sign up & pay option, event, Pro shop, or "Ask the school").
- Both extras: an "after N classes attended" trigger, and a family tapping "See how to join" creates a Lead pipeline follow-up for staff (the sheet tells the family the school will see the interest; no message is sent).
- Concept only from the reference app: no copied characters, artwork, colours, fonts or layouts. HON brand colours (spirit-orbit set) and HON's own character Eian.

## Objective
Make the family app feel friendly and rewarding for parents and kids, with Eian as the guide, without changing what any screen does or reads.

## Slices
1. **R1 look (frontend only).** Theme tokens (HON blue, lime, cyan, coral, sun, violet on a white base; dark scheme kept), Nunito font (SIL OFL, `@expo-google-fonts/nunito` + `expo-font`), chunky `Button` (raised 4pt bottom edge, presses down), raised `Card`, `Pill`, back button, tab bar with icon tiles and Eian's face as the raised center tab. Every screen picks this up through `ui/parts.tsx` and `ui/theme.ts`. No data or behaviour change.
2. **R2 Home path + reward (frontend only).** Home top bar: child picker and requirements met (`3/5`). Progress becomes a belt path of the current rank's requirements from the existing journey read (met = done, first not-met = next, rest = still to come, then a belt-test stop). Eian with a short line built only from read data. A "You're booked!" moment after a booking the server confirmed (not on waitlist or failure). Requirement text, status and the "Only instructors record results" note stay.
3. **R3 screens (frontend only).** More as coloured icon rows, Events choices as big chips, Pro shop two-column grid, announcement cards. Same calls and states.
4. **S1 weekly streak (backend + app).** New parent read: for each child of the selected family, the number of consecutive school-time-zone weeks, ending with the current or previous week, that have at least one CHECKED_IN attendance. Family-scoped through the existing parent guard and picker; returns a number only (no dates, sessions or staff). Needs a migration number from the coordinator if a SQL read is added. Shown as the flame count; hidden when unavailable.
5. **J1-J3 journey recommendations.** J1 database + staff API (migration from coordinator): per-program journey settings and recommendations (title, message, trigger: reaches rank / after N of M requirements in a rank / booked for belt test; target: checkout option, event, Pro shop, Ask the school; skip-enrolled flag; on/off). Forced RLS, staff command path with audit, family-scoped read that returns only the recommendations whose trigger the child has reached. J2 HON OS > Parent app > Journey page, which is also where staff add, rename and order belts and add requirements per belt (existing curriculum rank and requirement commands; no second store). J3 gift stop on the family path, with See how to join / Ask the school / Not now (per-family hide). Also: trigger "after N classes attended" (CHECKED_IN count in the program), and the join tap records interest as a lead follow-up through the existing lead pipeline command path (idempotent per family + recommendation).

## Boundaries
- Always: existing parent guards, family picker scope, verified contracts, fail closed (unavailable data is hidden or says so, never stale). Every touch target at least 48pt, screen-reader labels kept, text scales.
- Never: new charges or messages from a recommendation; eligibility or rank computed in the app; real family data in fixtures; any deploy or store build.
- Ask first: new commercial wording, paid services.

## Testing
Jest + React Native Testing Library in `apps/parent-mobile` (existing suites must keep passing; new tests for path model, tab bar, reward moment, streak display). Backend slices add proof scripts and API tests per repo rules. `npm run check`, `npm test`, `git diff --check` per PR.
