# HON OS schedule billing — piece 3 (migration 0237): HQ review queue for held payments, and the end of v1 founder/lifetime sales

Piece 3 of the owner's five-piece paid-activation plan (2026-11-09). It depends on pieces 1 (0230) and 2 (0235) and is not
deployed. Nothing here contacts a payment provider or executes a refund.

## Owner decisions this piece implements

| Decision | How |
| --- | --- |
| Answer 5: the v1 checkout stops selling founder and lifetime offers; existing buyers unchanged; standard v1 (OD-3) untouched | BEFORE INSERT trigger `saas_hon_os_v1_offer_kind` on `saas_checkout_sessions` refuses a HON OS (`hon_os_offer_id` set) `FOUNDER_MONTHLY`, `FOUNDER_ANNUAL`, `FOUNDER_LIFETIME` or `LIFETIME` checkout with `SAAS_OFFER_REQUIRES_SCHEDULE` (HTTP 422). Legacy catalog checkouts, standard HON OS v1 sales and every existing row are unchanged. |
| Answer 3: a payment is never auto-refunded and never treated as failed | The queue lists held money. The HQ owner may record `REFUND_OWED` (an obligation only, `providerActionExecuted: false`). Only the verification command, after the provider's own refund evidence is stored, clears the hold. |
| 2026-11-09 decision card: after a verified refund the plan carries on as before | A parked plan that was billing (`activated_at` set) goes back to `ACTIVE`; a plan never paid goes back to `BOUND_TEST_ONLY` (waiting for its first payment; the 7-day unpaid window still runs from sign-up). Status reason `REVIEW_REFUND_VERIFIED`. |

## What is held money

- **v1 checkout** `PAID_NEEDS_REVIEW`: each stored paid `checkout.session.completed` / `async_payment_succeeded` event for that
  checkout. Matched to refunds by payment intent (one-time) or first invoice (subscription mode).
- **Schedule binding** `NEEDS_REVIEW`, or an ended binding (`EXPIRED_UNPAID`, `VOIDED_PROVIDER_FAILED`,
  `CANCELLED_BEFORE_PAYMENT`) with review records: each stored `invoice.paid` event that was not counted (wrong amount, wrong
  period length, overlap, paid while parked, paid after the end). Matched to `charge.refunded` events by `relatedInvoiceReference`.
- Refund amounts are cumulative provider reports: the largest report per payment must equal the held amount exactly.

## Blockers (listed, no decision offered; need an owner policy or provider follow-up)

`NO_HELD_PAYMENT` (e.g. a provider terms mismatch with no money), `HELD_PAYMENT_CONFLICT`, `DISPUTE_POLICY_REQUIRED`,
`REVERSAL_POLICY_REQUIRED` (a refund or dispute of a counted payment: OD-11/12), `PAYMENT_REFERENCE_MISSING`.

## Commands and reads

| Route | Who | Notes |
| --- | --- | --- |
| `GET /v1/hq/saas/paid-reviews?cursor=` | HQ owner or HQ billing operator | Complete, cursor-paged (50) by subject `(created_at, id)`. Each item: held count and amount, refunded amount, blocker, `allowedDecisions`, open resolution, `accessRetryAvailable` (v1 access-program case keeps its existing HQ retry). |
| `POST /v1/hq/saas/paid-reviews/resolve` | HQ owner (rechecked after the organization lock) | `{subjectKind, subjectId, expectedVersion, decision, reason, confirmation:'RESOLVE_PAID_REVIEW_NO_PROVIDER_ACTION'}`. Only `REFUND_OWED` is built; `ACTIVATE` / `RESUME_BILLING` are refused `SAAS_BILLING_POLICY_UNAVAILABLE` (OD-14). One open obligation per subject. |
| `POST /v1/hq/saas/paid-reviews/:resolutionId/verify-refund` | HQ owner | `{expectedVersion, confirmation:'VERIFY_RECORDED_REFUND_EVIDENCE_ONLY'}`. Recomputes held money now (later payments must be refunded too). `SAAS_REFUND_EVIDENCE_MISSING`, `SAAS_REFUND_INCOMPLETE` (partial or over-refund), nothing written on refusal. |

All commands: idempotency key, same-key replay, different-key conflict, audit and inert outbox, version checks, lock order
organization -> subject row -> resolution row.

## Data and security changes

- `saas_paid_review_resolutions`: private, forced RLS, no runtime grants. Insert only by the resolve command (open request),
  one update `AWAITING_REFUND_EVIDENCE -> REFUND_VERIFIED` only by the verify command; no edit, delete or truncate (owner included).
- `saas_org_billing_conflict` (still STABLE, read-only) now clears a subject only when a `REFUND_VERIFIED` resolution covers
  every review record on it; a later held payment reopens it. It never infers a refund from raw evidence.
- `guard_saas_checkout_refund_recorded`: a held v1 checkout with a recorded refund can never be moved (e.g. activated by the v1 retry).
- Binding guard and deferred evidence check accept the two review exits only with the verified resolution of the open
  verification request and its audit row.
- `hon_runtime` gains EXECUTE on the three entry points only (restored in `infra/postgres/010`).

## Not in this piece

- Accepting held money without a refund (OD-14), refund/dispute effects on counted payments (OD-11/12), disputes on held money.
- A privileged worker path for refund verification (HQ owner only for now).
- Other HQ checks that still treat any `PAID_NEEDS_REVIEW` checkout as blocking (0185/0186/0219 provisioning and overview) stay
  conservative after a verified refund.
- The 0235 access retry still refuses a binding with any stored refund event (`SAAS_ACCESS_PAYMENT_REVERSED`), including a
  refund of a held payment; fails closed, follow-up.
- Piece 4 founder 50-spot counting; piece 5 screens.

## Evidence

- `packages/database/scripts/test-saas-schedule-billing-integrity.mjs` group 6 (schedule queue, refunds, plan returns).
- `packages/database/scripts/test-saas-hon-os-new-school-onboarding.mjs` (v1 held payments: obligation, partial refused,
  verified refund, v1 retry can never activate) and the three v1 sales proofs (refusal proven live, history replayed with
  the refusal set aside in the disposable database only).
- `apps/api/test/saas-paid-review.test.cjs` (closed contracts and routes); staging pins (0237 target and chain).
