# Membership date revisions: Codex frontend handoff (E1b-1)

The backend is described in [MEMBERSHIP_DATE_REVISIONS.md](MEMBERSHIP_DATE_REVISIONS.md). This note covers only what the staff frontend needs. Claude did **not** edit `apps/web`, which remains Codex-owned. Nothing existing breaks: the E1a activation and cancellation contracts are unchanged.

Types, validators and closed response verifiers are exported from `@hon/contracts` (`membership-date-revision.ts`): use `verifyMembershipDateRevisionPreview`, `verifyMembershipDateRevisionReceipt`, `verifyMembershipDateHistory`, `verifyMembershipDateConfirmationQueue` and `verifySchoolMembershipStatusSummary` on every response.

## Common rules

- All routes are under `/v1/organizations/:org/schools/:school/…` and use the signed-in staff session. Route identifiers are not authority; the server re-checks live permissions at that school.
- POST routes need same-origin JSON and the exact `X-HON-Human-Command` value below. `X-HON-Source`, action-request and delegated-actor headers are refused. Query parameters are refused (`400 VALIDATION_FAILED`).
- Unknown body fields are refused (`400`).
- Responses are `{ data, meta: { requestId, correlationId, replayed? } }` with `Cache-Control: private, no-store`.

## Routes

| Purpose | Request | Command header | Permission |
| --- | --- | --- | --- |
| Preview | `POST …/billing/memberships/:id/effective-period/preview` body `{changeKind}` or `{changeKind, startDate, endDate}` (`endDate` may be `null`). **No** `Idempotency-Key` (sending one → `409 IDEMPOTENCY_KEY_NOT_ACCEPTED`). | `billing.membership.dates.preview` | `dates.revise` |
| Confirm | `POST …/billing/memberships/:id/effective-period/revisions` with a fresh `Idempotency-Key` (≤200 chars) and the body below | `billing.membership.dates.revise` | `dates.revise` (+ `dates.retroactive` when the preview requires it) |
| History | `POST …/billing/memberships/:id/effective-period/history` body `{}` | `billing.membership.dates.history` | any of `billing.membership.read`, `billing.membership.activate`, `dates.revise` |
| Legacy queue | `POST …/billing/memberships/date-confirmation-queue` body `{}` or `{after, limit}` (`limit` 1–50, `after` from the previous `next`) | `billing.membership.dates.queue` | `dates.revise` |
| Status summary | `GET …/reports/membership-status` | none (GET) | `reporting.view` |

Confirm body:

```json
{
  "expectedVersion": 3,
  "expectedPeriodVersion": 1,
  "previewDigest": "<from preview>",
  "changeKind": "EXTENSION",
  "startDate": "2027-01-31",
  "endDate": "2027-03-30",
  "dateSource": "<preview.proposedDates.dateSource>",
  "dateAdjustmentReason": "only when dateSource is STAFF_ADJUSTED",
  "acknowledgedWarnings": ["<exactly the preview warning codes>"],
  "reasonCode": "<one of the kind's reason codes>",
  "reasonText": "10-500 characters, always required",
  "confirmation": "I_CONFIRM_MEMBERSHIP_DATE_CHANGE_NO_PAYMENT_INVOICE_REFUND_OR_AGREEMENT_CHANGE"
}
```

`expectedPeriodVersion` is `null` exactly for `INITIAL_CONFIRMATION`; otherwise send `preview.currentPeriod.periodVersion`.

## Screens

1. **Membership dates panel** (ACTIVE memberships): current confirmed period (start, inclusive end, school timezone), the effective status (`SCHEDULED`, `IN_EFFECT`, `ENDED`, `UNDATED`), and actions *Correct dates*, *Extend*, *End early* (or *Confirm dates* when UNDATED). Hide the actions without `dates.revise`; the server still enforces it.
2. **Preview step:** show suggested dates and their basis, proposed dates, effective status now and if confirmed, retroactive days added/removed, financial facts, every warning with its own acknowledgement control, and blocks (disable confirm). Show the not-evaluated list plainly: a date change does **not** record an agreement, consent or payment. If `canConfirm` is false only because `dates.retroactive` is missing, say that someone with the retroactive permission must confirm. Re-preview whenever the dates or kind change.
3. **Confirm step:** a second explicit confirmation, the reason code and reason text, and the adjustment reason when the dates differ from the suggestion.
4. **Receipt:** the new period, `retroactiveDays`, and the `BILLING_REVIEW` follow-up when present ("a billing review reminder was created; no payment, invoice or schedule was changed").
5. **History:** newest first, with actor, kind, dates, reason and retroactive days.
6. **Legacy date confirmation queue (D7):** one row per membership with its stored legacy instants labelled **unconfirmed**. Each is confirmed individually through the same preview/confirm flow with `INITIAL_CONFIRMATION`. **No bulk select or bulk confirm.**
7. **Status summary:** lifecycle totals, the ACTIVE split and the UNDATED hints (label hints as unconfirmed), plus confirmed starts/ends in the next 30 days.

## Errors to handle

`400 VALIDATION_FAILED`; `403 MEMBERSHIP_DATE_REVISION_FORBIDDEN`, `MEMBERSHIP_RETROACTIVE_DATE_REVISION_FORBIDDEN`, `MEMBERSHIP_DATE_HISTORY_FORBIDDEN`, `MEMBERSHIP_STATUS_SUMMARY_FORBIDDEN`; `404 BILLING_MEMBERSHIP_NOT_FOUND`; `409 MEMBERSHIP_NOT_ACTIVE`, `VERSION_CONFLICT`, `PERIOD_VERSION_CONFLICT`, `DATE_REVISION_PREVIEW_STALE`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_NOT_ACCEPTED`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`, `SCHOOL_TIMEZONE_INVALID`, `MEMBERSHIP_LIFECYCLE_CONFLICT`; `422 DATE_REVISION_BLOCKED`, `DATE_SOURCE_MISMATCH`, `DATE_REVISION_ACKNOWLEDGEMENT_REQUIRED`; `503 MEMBERSHIP_LIFECYCLE_UNAVAILABLE`.

On any 409 conflict or stale preview: re-preview, show the new result, and confirm with a **new** `Idempotency-Key`. Retry the same key only for a network failure with the identical body (the server replays the receipt with `meta.replayed: true`).

## Parent visibility (D10)

Do **not** show internal membership DRAFTs to parents in any form, including a "Not yet active" label. A future explicit, authorized, school-scoped publication action (E1b-2 or later) will decide what parents see. Never infer publication from the existence of a DRAFT, billing account or registration. E1b-1 does not change the parent billing view.
