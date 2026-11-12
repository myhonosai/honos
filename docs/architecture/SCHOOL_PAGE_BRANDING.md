# School page branding (0268)

Owner decision 2026-11-12 ("Branded pages"): a school sets its logo, accent color, cover photo and one contact line once,
and every family-facing page the school publishes (event and booking links, enrollment and tuition checkout) shows them.
Per page, the school writes its own text, questions, waiver and thank-you message; that lives with each page (for example
0269 checkout pages), not here. This is not a layout or page builder.

## What is stored

| Field | Rule |
| --- | --- |
| `logoUrl` | null, or a plain `https://` URL: lower-case host with at least one dot, path and query of URL-safe characters only (`A-Za-z0-9._~%/+=&?-`), 12 to 500 characters. No `data:`, no credentials, no quotes or spaces. |
| `coverUrl` | same rule as `logoUrl` |
| `accentColor` | null, or `#rrggbb` in lower-case hex |
| `contactLine` | null, or 1 to 160 characters, trimmed, one line, no `<` or `>` and no control characters |

HON stores the links only. It never uploads, copies, fetches, proxies or checks the images. Family pages load them with
`referrerPolicy="no-referrer"`; any page that shows a value checks it with the same contract validator first.

## Database (migration 0268)

- Permission `school_branding.manage` (sensitive, staff-assignable), granted to every system OWNER role.
- `hon.school_page_branding` (one row per school, `version` starts at 1 and goes up by exactly 1 per save, never deleted or
  truncated, scope fixed) and `hon.school_page_branding_versions` (append-only history). Both have forced RLS and no
  runtime table privilege.
- `hon.read_school_page_branding(subject)` and `hon.save_school_page_branding(subject, p, key, request, correlation)`:
  direct human command only (0239 identity settings), live `school_branding.manage` at the current school, ACTIVE
  organization, school and entitlement window, not an HQ operator, family or parent/student role. The actor is checked
  again after the table locks and before the answer. Save is idempotent per key (exact replay returns the first receipt,
  another body under the same key is `IDEMPOTENCY_KEY_REUSED`), uses an expected version (`0` creates), and writes one
  version row, one audit event (`school_branding.save`) and one inert outbox event (`school_branding.saved`, ids and
  version only).
- `hon.read_public_school_branding(selected uuid)`: display branding plus the school name for an ACTIVE school of an ACTIVE
  organization, or null. No ids and no people. It is for server code that already resolved the school from a public link;
  each caller (booking, checkout) makes its own entitlement decision. There is no public HTTP route for it.
- Runtime role: EXECUTE on those three functions only. `infra/postgres/010` grants them and `011` verifies the exact bodies.

## API

`GET` and `POST /v1/organizations/:organizationId/schools/:schoolId/settings/branding`, each under its own human-UI guard
(`school_branding.read`, `school_branding.save`). The route scope is resolved from the verified session, never trusted
from the URL. Read takes no query and no Idempotency-Key; save needs an Idempotency-Key. Errors: `VALIDATION_FAILED` (400),
`SCHOOL_BRANDING_FORBIDDEN` (403), `VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`,
`SCHOOL_BRANDING_CONFLICT` (409), anything else `SCHOOL_BRANDING_UNAVAILABLE` (503).

## Web

Settings › School branding (`/staff/settings/branding`): the four fields, a color picker, a live preview built only from
values that pass the validators, save with an in-memory retry of the identical request when the outcome is unknown, and a
fresh read after every save answer. Nothing is kept in browser storage.

## Proof

`packages/database/scripts/test-school-page-branding-integrity.mjs` (crm-lead-close fixture, signed HTTP): permission,
refusals, validation of every field, create/replay/key reuse/replace/clear, public read for active schools only, live
authority loss, history/audit/outbox, guards, runtime ACL and the 011 section.

## Not in this change

- Using the branding on the event booking page and the checkout pages (the next booking and checkout slices call
  `read_public_school_branding`).
- Image upload or hosting. If the owner wants uploads later, that is a separate decision (storage provider and cost).
