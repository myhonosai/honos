# School onboarding answers and setup progress (0323)

Part of David's "Complete Customer Onboarding Vision" (2026-11-12). Implementation matrix: `/mnt/project-files/onboarding/ONBOARDING_IMPLEMENTATION_MATRIX.md` (items B1, B2).

## What it stores
One versioned row per school (`hon.school_onboarding_profiles`): situation, disciplines (+ custom name), goals, path (`NEW` or `SWITCHING`), previous software, what to bring over, and optional steps the owner chose to skip. Saved only through `hon.save_school_onboarding` by a direct human with `onboarding.manage` (backfilled to every system OWNER role). Whole-set save with `expectedVersion`, an idempotency key, exact replay, identifier-only audit and inert outbox.

## What it never stores
Progress. `hon.read_school_onboarding` recomputes every step on each read from live records:

| Step | COMPLETE when | Otherwise |
|---|---|---|
| SCHOOL_DETAILS | school exists (name + time zone from sign-up) | - |
| WELCOME | situation, at least one goal and a path are saved | IN_PROGRESS once anything is saved |
| INTERFACE | this person chose a presentation mode for this school | NOT_STARTED |
| PROGRAM | a SCHEDULED program | IN_PROGRESS with only DRAFT programs |
| CLASS_SCHEDULE | an ACTIVE class series or an upcoming SCHEDULED session | NEEDS_REVIEW with only past sessions |
| MEMBERSHIP_PLAN | a plan whose current version is AVAILABLE | IN_PROGRESS with only unavailable plans |
| FIRST_LEAD | a lead that is not ARCHIVED | NOT_STARTED |
| TRIAL_BOOKED (optional) | a SCHEDULED or COMPLETED appointment | NOT_STARTED |
| FIRST_STUDENT | an ACTIVE student profile | NOT_STARTED |
| STAFF (optional) | an ACCEPTED staff invitation | IN_PROGRESS with an unexpired PENDING one |
| IMPORT (optional, not on the NEW path) | a FINALIZED student or lead import | NEEDS_REVIEW with a staged one |

So cancelling every class turns CLASS_SCHEDULE back to NOT_STARTED. `skipped` is shown only while a step is not complete.

## Before access starts (owner decision D3, 2026-11-12)
A signed-up school without a trial or paid access may answer the welcome, choose interface and language, and contact support. The actor check therefore needs no active entitlement, and while none is active every school-data step reads `UNAVAILABLE` without reading school data. `access.state` is `ACTIVE`, `NOT_STARTED` or `ENDED`; trial status and end come from 0246.

## API
- `GET /v1/organizations/:org/schools/:school/onboarding` (same-origin browser GET)
- `POST /v1/organizations/:org/schools/:school/onboarding/profile` with `X-HON-Human-Command: onboarding.profile.save` and `Idempotency-Key`

Route ids are never authority: scope is resolved from the verified session and re-proved in the database.

## Not in this slice
HQ view of onboarding (B5), the welcome and checklist screens (next PR), support requests (0335).
