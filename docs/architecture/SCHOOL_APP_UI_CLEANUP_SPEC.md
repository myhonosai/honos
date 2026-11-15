# School app UI cleanup: spec and plan (2026-11-14)

Owner request (David, 2026-11-14): the school app at app.myhonos.com is "all over the place" and the menus are
"weird". Goal: the school-facing screens read as one plain-language product: one navigation, readable contrast on
the blue theme, the school taken from the signed-in session, no internal jargon, and AI pages that show real
availability. Then a guided tour of each section, and Settings as a summary page with onboarding kept to onboarding.

Frontend copy and layout only. No API, database, billing, entitlement, AI-spend or deployment change.

## Audit summary

| # | Symptom | Cause |
|---|---|---|
| 1 | Top bar silently drops 8 of 14 areas | `nth-child` hides items with no More control |
| 2 | Top bar ~260px tall on short pages | Shell grid splits leftover height between bar and page |
| 3 | Menu grid hides each area's first page; cuts lists at 4 | `routes.slice(1, 5)` |
| 4 | AI Team lists Chad, Marcus, Kai, Teaching studio, Maya | Old catalog; Alex, Jordan, Lena, Claire unreachable; Teaching studio has no AI |
| 5 | Duplicate blue link rows and a "Sign in" link inside pages | 18 pre-shell pages carry their own `Staff navigation` row |
| 6 | Faded text (dark on dark, light on white) | Legacy canvas decided from the page's outer element only |
| 7 | AI pages show OPENROUTER_API_KEY, "legacy claire record key", NOT_CREATED_OR_SENT | Hard-coded developer text, not the live readiness read |
| 8 | Organization/School UUID inputs while signed in | 17 pre-shell pages never read the shell's verified school |
| 9 | Home shows Maya, Alex, Jordan, Claire, Lena as "Not available yet" | Home model predates 0260/0284 and maps Kai to the old `claire` key |

## Slices (one PR each)

1. **Menus and readability** (this PR): items 1-6 and 9. New `/staff/ai-team` page: Kai and the seven specialists
   with status from `GET .../ai/team/capabilities` (never from the portrait), "Open workspace" for Chad, Marcus,
   Kai and Maya, "Ask <name>" for Alex, Jordan, Lena and Claire via `/staff/hon?ask=<id>` (#355). Teaching studio
   moves to Attendance & Curriculum. Menu grid lists every page. A "More" button in the top bar opens the Menu.
   Legacy `Staff navigation` rows and the in-nav sign-in link are hidden inside the shell (the shell owns
   navigation and sign-in). The legacy light canvas is chosen from the page heading's own colour and surface.
2. **AI pages, Search, Leads**: plain-language headers, readiness-driven status, school from the shell.
3. **Remaining UUID pages**: fill selectors from the shell's verified school and hide the fields.
4. **Settings summary**; Welcome, Launch and Founder setup reachable from onboarding, not Settings tabs.
5. **Guided tour** over the final menu.

## Boundaries

- The shell's selection stays a navigation selector only; every page API re-authorizes the exact school.
- Status never claims availability without a verified readiness read: loading, denied and unverifiable are distinct.
- Hiding legacy navigation removes no route: every page stays reachable from the shell catalog (test-enforced).
