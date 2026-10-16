# HON ClassPass & Walk-In

## Status and scope

Migrations `0117`–`0121` provide the **initial, nonfinancial ClassPass allowance and walk-in admission vertical**. It reuses HON's existing school scope, canonical class sessions/bookings, capacity facts, function-only attendance, idempotency records, immutable audit history, and transactional outbox. It does **not** create a second booking, attendance, membership, billing, payment, or AI execution model.

> A ClassPass in this slice is a **manual nonfinancial operational allowance**. It is not a product sale, payment success, invoice, payment reconciliation, provider receipt, credit, refund, or customer price.

A payment-backed purchase, reconciliation-backed issuance, refund, and any provider integration remain deliberately deferred until a separate canonical payment/reconciliation boundary is reviewed and validated.

## Direct-human authority

Only an exact `HUMAN_USER` + `HUMAN_UI` command may configure/retire an allowance product, issue a pass, admit a walk-in, or make a permitted reversal. Each function rechecks:

- matched external subject and one active human principal;
- active organization, school, and an Essential/Core/Complete entitlement;
- current exact school role permission; and
- absence of delegation or an Action Engine request.

Permissions are intentionally separate:

| Permission | Bounded capability |
|---|---|
| `classpass.manage` | Configure/retire a product and issue a **manual nonfinancial** allowance |
| `classpass.admit` | Make one capacity-safe ClassPass walk-in decision |
| `classpass.reverse` | Perform the two narrowly defined reversals |
| `classpass.read` | Read one exact staff product, pass, or ClassPass booking |

AI, automation, integration, parent/guardian and HQ principals cannot use staff ClassPass commands. No generic booking input accepts `CLASS_PASS`.

## Data and canonical records

`classpass_products`, `classpass_passes`, and `classpass_ledger` are school-owned, forced-RLS private tables with no runtime table policy. The restricted runtime receives only tightly scoped fixed-function execution; it has no direct table mutation access.

- Products are program-scoped operational allowances: name, included uses, validity days, and walk-in-only policy—**never price, currency, payer, membership, invoice, payment, card, purchase or provider fields**.
- A pass freezes the product/program name, version, allowed uses, duration and expiry at issuance. Later product edits or retirement do not reinterpret it.
- The signed ledger is append-only: `ISSUANCE`, `REDEMPTION`, `ISSUANCE_REVERSAL`, and `REDEMPTION_REVERSAL` facts are never edited or deleted.
- A ClassPass booking is the existing canonical `hon.class_bookings` row with a system-created `CLASS_PASS` kind and an exact pass link. ClassPass does not create a separate attendance record; the existing function-only attendance command remains authoritative.

Every command atomically writes its business change, idempotency outcome, redacted audit event and inert internal outbox event. The outbox has `externalEffects: NONE`; no worker, provider, payment, messaging, Action Engine, or delivery consumer is activated by this slice.

## Walk-in decisions

The exact pass and scheduled session are supplied; the student is always derived from the pass. The server locks **idempotency → session → pass → existing canonical booking** and rechecks authority after potentially blocking waits.

The command rejects wrong school/program, inactive program/student, non-`WALK_IN` or unscheduled/closed session, age evidence mismatch, expired/reversed/exhausted pass, stale pass version, duplicate incompatible booking, or ambiguous ledger evidence.

| Condition | Canonical booking | Ledger / remaining uses | Receipt decision |
|---|---|---|---|
| Capacity exists | `BOOKED` | one `REDEMPTION`, decrement one use | `ADMITTED_REDEEMED` |
| Full class | `WAITLISTED` | no redemption; no decrement | `WAITLISTED_NOT_REDEEMED` |
| Later retry after space exists | Same waitlisted booking becomes `BOOKED` | one redemption, once | `ADMITTED_REDEEMED` |

The generic staff booking command keeps its pre-existing `WALK_IN` over-capacity behavior. ClassPass does **not** inherit that behavior: it reports a waitlist and never consumes a use when there is no seat.

## Narrow reversals

- **Issuance reversal** is available only for a direct-human manual nonfinancial pass that has never been redeemed and still has all of its original uses. It appends `ISSUANCE_REVERSAL`; it is not a refund.
- **Redemption reversal** is available only before class start, before check-in/attendance, before expiry, and only for the exact ClassPass booking/debit. It cancels that canonical booking, restores exactly one use and appends `REDEMPTION_REVERSAL`.

No reversal auto-promotes a waitlist. No original ledger fact is changed. Ambiguous, expired, revoked, attended, checked-in or financial/payment-related situations fail closed and require a separately governed workflow.

## Staff and parent experience

- `/staff/classpass` is a same-origin, no-directory staff workbench for exact product/pass/booking records and direct commands. A verified Staff Dashboard or School Command Center may prefill only its returned organization/school UUID pair through the URL; the selectors remain untrusted, the page makes no automatic read or command, and every later operation repeats its direct-human server authorization. It keeps idempotency keys for an unchanged retry and labels **booking**, **walk-in decision**, **redemption**, **attendance**, and **payment/provider outcome** separately. A full class visibly means no redemption.
- `/parent/classpass` is an authenticated, no-index, fixed GET view. It derives exactly one current guardian family from the existing resolver; it accepts no selectors, body, or `X-HON-*` authority headers. It returns only active `STUDENT` family members, bounded safe display names, allowance uses/expiry/status, relevant booking/redemption outcome and the existing attendance state when recorded. It never returns IDs, ledger/actor/request/program/staff data, payment/provider data, hidden family members, or parent command capability.

Both interfaces say **payment/provider outcome unavailable**. Neither can purchase, charge, refund, issue a pass from the parent surface, admit/redeem/reverse from the parent surface, change attendance, send messages, invoke AI, or call a provider.

## Guarded local validation

The test database is marked and localhost-only. It rejects remote/unmarked targets, inherited database URLs, provider/payment/communication/execution environments, unsafe credential output paths and symlinks. Generated credentials are descriptor-bound in a private mode-0600 job file and are not project artifacts.

```bash
# Use a new, private, nonexistent file beneath /home/ubuntu/jobs/<job-id>/.
env -i PATH="$PATH" HOME=/home/ubuntu LANG=C.UTF-8 \
  HON_CLASSPASS_VALIDATION_TARGET=postgresql://localhost:5432/hon_classpass_validation \
  HON_CLASSPASS_ENV_FILE=/home/ubuntu/jobs/<job-id>/classpass-validation.env \
  pnpm db:setup-classpass

env -i PATH="$PATH" HOME=/home/ubuntu LANG=C.UTF-8 \
  HON_CLASSPASS_ENV_FILE=/home/ubuntu/jobs/<job-id>/classpass-validation.env \
  pnpm db:test-classpass
```

The integrity suite rebuilds all migrations, reapplies canonical least-privilege grants, runs canonical SQL and JS RLS verification, then tears down its marked database/roles. It covers exact ACL/grant-option drift, RLS, school/role/tier/principal revocation, product/session/student/pass eligibility, expiry/final-use cases, capacity/waitlist/retry/concurrency, generic/ClassPass coexistence, reversal gates, ledger append-only behavior, parent family redaction/topology/revocation, atomic audit/outbox rollback, and zero payment/provider/message/AI/Action Engine effects.

## Deferred work

1. Payment-backed ClassPass purchases and reconciliation-backed issuance/reversal.
2. ClassPass checkout, invoices, raw/payment provider inputs, refunds or credits.
3. Self-Service Kiosk terminal sessions, which may only build on this audited admission result and existing check-in boundary.
4. Any AI or Action Engine proposal/execution capability for ClassPass.
