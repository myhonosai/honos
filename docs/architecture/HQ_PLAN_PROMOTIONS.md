# HQ plan promotions (migration 0308)

**Status:** source only, not deployed. Owner ask (David, 2026-11-12): "Since we are going to allow change in payment plans, there should be a way for HQ to promote that to school accounts." Spec: `/mnt/project-files/plan-promotions/PLAN_PROMOTIONS_SPEC.md`.

## What it does

An HQ owner writes a short in-app promotion (headline, body, button label) that links to **one offer of the published HON OS offer set** (0181), picks the audience and a window of up to 90 days, previews it, and starts it by echoing the preview digest. While it is live, staff holding `billing.hon.purchase` at a targeted school see it in the app; the button takes them to that offer on `/staff/subscription`, where the actual purchase or switch happens through the existing billing path. HQ sees real counts of seen, opened and dismissed records, and how many of the schools that saw it later started a purchase of that offer.

## What it never does

It never sets a price, creates or changes an offer, starts a checkout, switches a plan, gives credit, sends an email or text, or touches billing, entitlements, payments or creative credits. Nothing exists until an HQ owner creates and starts a promotion. Email/text hand-off is a later slice and needs the owner's OK before any real message is sent.

## Authority

| Action | Who |
|---|---|
| Create, edit (DRAFT only), start, pause, resume, end | Current HQ owner only (`require_saas_hq_actor(subject, true)`): promoting pricing is commercial policy |
| HQ list and detail (with preview and reach) | HQ owner, or HQ operator with `hq.marketing.manage` / `hq.marketing.read` (0252 rule) |
| School list, seen/opened/dismissed | Staff with `billing.hon.purchase` at the exact school (`require_saas_school_purchaser`) |

## When a school sees a promotion

All must hold at read time:

1. Status `ACTIVE` and now inside `[startsAt, endsAt)`.
2. The offer is on sale (`saas_hon_os_offer_on_sale`: published set, sales window open, no sales stop).
3. The school is in the audience: `ALL_SCHOOLS`, `MONTHLY_PLAN`, `ANNUAL_PLAN`, `TRIAL`, `NO_PLAN` or `SELECTED_SCHOOLS` (≤ 500). The school's plan comes from a live HON OS trial, else its live schedule binding interval, else its HON OS subscription, else `NONE`.
4. The school is not already on the promoted offer's billing interval, the school and organization are active, and there is no open billing review (`saas_org_billing_conflict`).
5. The subscription page's own offer read (`read_saas_hon_os_offers_for_school`) lists the promoted offer as `ELIGIBLE` for this organization. So a promotion never shows an offer the school cannot buy now; when founder billing changes eligibility (0306 lifetime, 0307 direct switch), promotions follow automatically.

The school view carries only display fields and an offer summary (no audience, digest, reach or HQ data).

## Lifecycle

`DRAFT → ACTIVE` (needs the current preview digest, the window not ended, the offer on sale or opening later) `| ENDED`; `ACTIVE → PAUSED | ENDED`; `PAUSED → ACTIVE` (same window and offer checks, no new digest) `| ENDED`. `ENDED` is final. Content is editable only in DRAFT; a live promotion is changed by ending it and creating another. Every change bumps the version and writes an immutable version snapshot; commands are idempotent by actor and key.

## Tables and boundary

`hq_plan_promotions`, `hq_plan_promotion_versions`, `hq_plan_promotion_requests`, `school_plan_promotion_events` (one row per promotion, person and kind). Forced RLS on all four, no table privileges; triggers refuse any change to history, requests and events, and any content or approved-digest change after start, even for the migration owner. The runtime executes exactly seven entry points: `create_hq_plan_promotion`, `update_hq_plan_promotion`, `set_hq_plan_promotion_status`, `read_hq_plan_promotions`, `read_hq_plan_promotion`, `read_school_plan_promotions`, `record_school_plan_promotion_event` (also restored in `infra/postgres/010_supabase_hon_runtime.sql`).

## API

- `GET /v1/hq/plan-promotions?status&cursor&limit`, `GET /v1/hq/plan-promotions/:id`
- `POST /v1/hq/plan-promotions` (`hq-plan-promotion-create`), `POST /v1/hq/plan-promotions/:id/versions` (`hq-plan-promotion-update`), `POST /v1/hq/plan-promotions/:id/status` (`hq-plan-promotion-status`)
- `GET /v1/schools/:schoolId/plan-promotions`, `POST /v1/schools/:schoolId/plan-promotions/:id/events` (`school-plan-promotion-event`, body `{kind}`)

Contracts: `packages/contracts/src/hq-plan-promotions.ts`.

## Evidence

- DB proof `packages/database/scripts/test-hq-plan-promotions.mjs` (Champions Club fixture, 8 groups).
- API/contract tests `apps/api/test/hq-plan-promotions.test.cjs`.
- `read_school_plan_promotions` is on the entitlement-coverage `OPEN_BY_DESIGN` list (billing recovery read; shows only offers the school is already eligible to buy).

## Follow-ups

- HQ screen (Marketing & Creative → Plan promotions) and the school banner + `/staff/subscription?offer=<id>` preselection (display only; preselect only an `ELIGIBLE` offer from the server list; never starts checkout).
- TRIAL audience is implemented but not yet covered by the DB proof (needs a trial fixture).
- Email/text hand-off through the communications stack: owner approval required.
