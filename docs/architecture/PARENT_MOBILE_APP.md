# HON Family (parent) mobile app — audit, architecture and plan

Status: spec + plan (2026-11-17). Owner vision: `/mnt/project-files/parent-app/VISION.md` (David, 2026-11-17).
The vision describes the intended final product. Nothing below claims a feature exists unless the audit says so,
with the file that proves it. Workspace: `apps/parent-mobile` (React Native + Expo + TypeScript).

## 1. Repository audit and gap matrix (main @ 4d7dad9)

Legend: **Verified** = a parent-scoped endpoint + contract verifier + proofs on main. **Partial** = some of it exists.
**Absent** = nothing parent-facing. **Blocked** = needs an owner decision or paid/external service.

| Area | State | Evidence / gap |
|---|---|---|
| Native app | Absent | No React Native/Expo code anywhere. `apps/web/src/app/complete-mobile` is a web page, not native. |
| Mobile sign-in | **Absent (first blocker)** | API authenticates only the `hon_session` cookie (`apps/api/src/foundation/hon-identity.service.ts`). POST "human UI" guards require `Origin == PUBLIC_ORIGIN` + `x-hon-human-command` (`apps/api/src/curriculum/curriculum-human-ui.guard.ts`). A native app has neither. Needs M2 (below). |
| Family scope | Verified (single family) | `resolve_parent_journey_scopes`; every parent read refuses with `PARENT_SCOPE_DENIED` 403 / `PARENT_SCOPE_AMBIGUOUS` 409 / `PARENT_SCOPE_CHANGED`. |
| School/family picker | Partial (in flight) | Web portal thread: `GET /v1/parent/families`, `POST /v1/parent/families/current` (0456), `packages/contracts/src/parent-family-picker.ts`. Choice stored per user, shared by web and app. |
| School identity/branding for parents | Partial | `schoolName` arrives with the picker. Logo/colors are staff-only (`school-branding.controller.ts`). Gap: parent-scoped branding read. |
| Home aggregate | Verified | `GET /v1/parent/journey` → `verifyParentJourneyView` (children, programs, rank, requirements, 31-day schedule, achievements, documents). Display-only: no ids. |
| Schedule read | Verified | Journey schedule + `GET /v1/parent/class-bookings` (14-day choices, school timezone, spots left). |
| Class booking / cancel | Verified (web + app) | `POST /v1/parent/class-bookings`, `/:id/cancel` (0329), Idempotency-Key, versioned cancel. App Schedule tab books/cancels natively (M3a); guards pass via the M2 native rule. |
| ClassPass | Verified | `GET /v1/parent/classpass`. |
| Planned absence | Verified | `GET /v1/parent/planned-absences/context`, `POST /v1/parent/planned-absences`, `GET .../history`. Status separate from makeup/booking. |
| Makeup classes | Absent | No makeup entitlement/policy engine for parents. Booking `kind: MAKEUP` exists only as a session kind. |
| Attendance history | Partial | Journey bookings carry `CHECKED_IN`/`NO_SHOW`; no parent attendance-history read. |
| Journey / rank / requirements | Verified | Journey view + `GET /v1/parent/schools/:s/families/:f/student-journey`. School-configured ranks, no hardcoded belt order. |
| Achievements | Verified | `GET /v1/parent/students/:student/achievements` (published, non-withdrawn only). |
| Curriculum library | Verified (links/metadata) | `GET /v1/parent/curriculum-library`. No native video hosting/offline. |
| Testing status | Verified | `GET /v1/parent/testing/status` (candidate vs interest vs certificate kept separate). |
| Testing registration | Partial | `POST /v1/parent/testing/interests` = interest only; no fee/payment registration. |
| Membership & billing read | Verified (read-only) | `GET /v1/parent/billing` (memberships, invoices, payment attempts incl. UNKNOWN). Payer link verified. |
| Parent payments / renewals / payment method | Absent / Blocked | School payment controllers are staff-only. Live money needs owner approval. |
| Messages | Verified | `GET/POST /v1/parent/messages/school` (0330 two-way), `GET /v1/parent/messages` (history). |
| Announcements | Partial | Knowledge feed `GET /v1/parent/schools/:s/families/:f/knowledge`; no announcement/targeting model for parents. |
| Push notifications | Absent | No device-token table, no push delivery records. |
| Documents | Verified | `GET /v1/parent/schools/:s/documents/publications`, ack POST, receipts. |
| Membership agreement + photo | Partial (PR #460, GO, unmerged) | `GET /v1/parent/membership-agreement`, `POST .../sign`, `POST /v1/parent/person-photo/set|remove` (base64 JPEG ≤ 400 KB). |
| Face check-in consent | Verified | `GET /v1/parent/face-check-in`, `POST sign|withdraw`. |
| Events | Partial | Public event booking (`/v1/public/events/:publicId/bookings`); no signed-in family registration with student selection. |
| Referrals / Champions | Partial | `schools/:schoolId/champions/*` (referral code, leaderboard pref); parent-scope fitness to verify before use. |
| Community | Absent for parents | Staff-only (`staff/community`). |
| Store (Shopify) | Absent for parents | Shopify sync exists for staff (#426); no parent storefront. |
| Language | Verified | `GET/POST /v1/me/language-preference` (en/ko/es). |
| Eian | Absent | Only labels ("Parent App / Eian — Queued"). No parent AI tools, no budget path. |
| Legal name / DOB correction | Absent | Prototype only; not production. |

## 2. Screen and navigation architecture

Bottom tabs (fixed): **Home | Schedule | Eian (center, raised) | Messages | More**. Every Eian task also has a normal screen.

```
Root
├─ Auth stack:  Welcome → Sign in (system browser, PKCE) → Choose school/family (if needsChoice) → First-run welcome
└─ App tabs (one active family scope; child selector in the header of Home/Schedule/Journey)
   ├─ Home: family header, child chips (All / each child), next class card, action-required, child progress cards, documents, quick actions
   │   └─ Child Journey: rank path, requirements, achievements, curriculum, testing status
   ├─ Schedule: upcoming list (Today/Week/Month), class detail, book, cancel, planned absence (+ history), ClassPass
   ├─ Eian: assistant home, conversation, action review card, execution result, history
   ├─ Messages: school thread, message history, announcements (knowledge feed), notification center
   └─ More: membership & billing, testing, documents & agreement, face check-in consent, curriculum library,
            events, referrals, store, family profile, language, security (sign out, biometric lock), support, school info
```

Child selection is a client view filter over one server-authorized response. It is never sent as authority:
the journey contract has no child ids, so the selector keys children by position in the current response and
clears on every refetch. Two children with the same name stay distinct by position.

State model shared by every screen: `signed-out`, `loading`, `ready`, `empty`, `choose-family` (needsChoice),
`access-denied` (403 scope denied/changed: cached data is wiped), `unavailable` (503 / verifier failure),
`offline` (network error; last data shown only as read-only with a "not current" banner, never for writes).

## 3. Typed API integration plan

- One client module (`src/api/`) wraps `fetch` with: base URL from `EXPO_PUBLIC_HON_API_URL`, the session token,
  `Accept: application/json`, no cookies (`credentials: 'omit'`), a 15 s timeout, and response verification
  with the **existing** verifiers from `@hon/contracts` (imported from source; no copies of contract types).
- Errors map to the state model by status + `code`: 401 → signed-out (token wiped), 403
  `PARENT_SCOPE_DENIED|PARENT_SCOPE_CHANGED|CHILD_SCOPE_CHANGED` → access-denied (cache wiped), 409
  `PARENT_SCOPE_AMBIGUOUS` → choose-family, 5xx/verifier failure → unavailable.
- Mutations (M3+): always `Idempotency-Key` (UUID, kept until a definite answer), `expectedVersion` where the
  contract has it, `x-hon-human-command` per command. A network failure leaves the result UNKNOWN; the app
  re-reads before offering a retry with the same key.
- **M2 backend contract (mobile session):** native OIDC Authorization Code + PKCE in the system browser
  (`expo-auth-session`), then `POST /v1/auth/mobile/session` exchanges the code server-side (client secret never
  on the device) and returns a short-lived HON session token with a distinct audience (`hon-mobile`).
  `HonIdentityService` accepts exactly one of cookie **or** `Authorization: Bearer` (both → reject).
  Human-UI POST guards accept a bearer `hon-mobile` session without `Origin` (no ambient credential, so no CSRF),
  still requiring `x-hon-human-command`. Token stored in `expo-secure-store`; sign-out and any 401 delete it.
- Push (M4): device-token registration table with family scope re-resolved at send time; previews carry no
  child names; a push after revocation opens to a fresh authorized read, never cached content.

## 4. Eian capability and action-authority map

Eian runs server-side only, as the signed-in guardian, with a family-safe tool catalog. It never inherits school
or HQ agent tools (Alex, Kai, Marcus, Chad, Lena, …). Every tool is the same endpoint a button uses.

| Tier | Tool | Backing service | Rule |
|---|---|---|---|
| Answer | next class, schedule, attendance marks | journey view, class-bookings GET | Read current scope; say "not recorded" when absent. |
| Answer | rank, requirements, achievements | journey, achievements | Never infer eligibility from progress. |
| Answer | testing status | testing/status | Interest ≠ registration ≠ result ≠ promotion. |
| Answer | membership, invoices, payments | parent/billing | Only if payer link verified; UNKNOWN stays unknown. |
| Answer | school policies/FAQ | parent family knowledge | Published articles only; cite the article. |
| Prepare + confirm + execute | book / cancel class | parent class-bookings POST | Parent taps Confirm on an action card; result shown from the receipt. |
| Prepare + confirm + execute | planned absence | planned-absences POST | Status shown as Submitted, not approved. |
| Prepare + confirm + execute | testing interest | testing/interests POST | Labeled "interest", never "registered". |
| Prepare + confirm + execute | message the school | messages/school POST | Marked as sent by the parent via Eian. |
| Prepare only | document ack, agreement signing, payments, payment method, renewals | — | Opens the normal screen; Eian never signs, pays or collects card data. |
| Refused | other families, CRM leads, revenue, staff data, rank changes, fee waivers, makeup credits, SQL | — | Server-side tool absence, not prompt text. |

Cost: uses the existing S4 AI spend guard and school budget; no per-message parent charge; does not draw on the
creative-credit wallet. David (2026-11-17): Eian is included for families with **no per-family cap**; the school AI
budget and server-side safety controls still apply. No real AI provider until David separately authorizes it.

## 5. Phased plan with verifiable milestones

| Milestone | Scope | Verified by |
|---|---|---|
| **M1 (this PR)** | Expo workspace (outside the pnpm workspace, own lockfile), 5-tab shell, HON mobile design tokens, typed API client with contract verifiers, session store, Home with child selector, Child Journey, honest states | Jest unit + screen tests; `tsc`; `expo export` bundle for iOS+Android |
| M2 | Mobile sign-in backend (bearer `hon-mobile` session, PKCE exchange, human-UI guard extension) + app sign-in; picker screen on the web thread's `GET/POST /v1/parent/families` | API unit tests + guard negatives (cookie+bearer, wrong audience, Origin-less cookie); app tests |
| M3 | Schedule tab: class booking/cancel, ClassPass, planned absence + history, messages (two-way), documents + ack, testing status/interest, billing read, face consent, agreement + photo (after #460) | Per-flow tests incl. retry with same key, FULL/CLOSED, revoked mid-session |
| M4 | Push notifications (backend tokens + delivery records), announcements, parent branding read, language | DB proofs + device test on EAS dev build |
| M5 | Eian text slice: server tool loop with the map above, action cards, receipts; then voice | Tool-denial and scope tests; no provider calls until approved |
| M6 | Makeup policy engine, events registration, testing fees/payments, renewals, referrals, store, community | Each needs its own backend contract; payments need owner approval |
| M7 | Store distribution: EAS profiles, shared HON app listing, branded-app pipeline | Manus builds/submits from David's accounts after his OK |

Decided 2026-11-17: app id `com.myhonos.family`, store name "HON Family", test builds on app.myhonos.com, Eian
with no per-family cap. Open owner decisions: branded-app pricing; whether VIEWER sees billing; makeup policy defaults
(none assumed); push provider (Expo push service vs direct APNs/FCM).
