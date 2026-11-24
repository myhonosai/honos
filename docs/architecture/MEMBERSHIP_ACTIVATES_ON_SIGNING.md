# Membership activates on signing (0680)

Owner decision (David, 2026-11-22, decision card "When should a new membership become active?"): **"When signed, or staff start it."**

- Staff Start already exists. It is the 0177 preview and confirm, which the contact card has offered since 0624.
- This migration adds the other half: signing the membership agreement starts the membership.

## What happens

A guardian can sign the school's current agreement version for a child in two places: the parent portal (0463) or a signing link (0499). When the transaction commits, a deferred constraint trigger on `hon.membership_agreement_signatures` looks at each of that child's DRAFT memberships, oldest first. For each one:

1. It takes the 0177 locks in the 0177 order, then runs the unchanged `hon.evaluate_membership_activation`.
2. It starts the DRAFT only if nothing is left for staff to decide. That means no blocks, no overridable warning, and no warning other than `START_DATE_IN_FUTURE`.
3. It writes the same evidence a staff start writes:
   - the 0177 decision row;
   - the INITIAL effective period;
   - the DRAFT->ACTIVE change, which passes the settings-free transition trigger;
   - an audit row;
   - the usual `billing.membership.activated` outbox event (schema 2).

   Because the event is the usual one, a school's "membership activated" automations react as they do to a staff start.
4. It records the outcome in `hon.membership_signing_activations`, as STARTED or LEFT_FOR_STAFF with reason codes.

Each start runs in its own subtransaction. If a start is refused or hits a lock conflict, only that start's writes and locks roll back. The DRAFT is left for staff and the signing still commits. If the signing rolls back, nothing starts.

## Dates

| Case | Result |
|---|---|
| The staff start date is today | Starts today on the plan term. |
| The staff start date is in the future | Kept. The membership is ACTIVE and SCHEDULED until that day. |
| The staff start date has passed | Starts on the signing day in the school timezone. A plan's fixed term is recounted from that day. The period is recorded as `STAFF_ADJUSTED` with the reason "Started on the day the membership agreement was signed…". |
| The start has passed and the end date comes from the DRAFT, not the plan | Left for staff (`START_DATE_PASSED_DRAFT_END_DATE`). |

A membership never starts before it was signed.

## Left for staff

Anything the 0177 gate asks staff to decide leaves the DRAFT unchanged. The reason codes are recorded. Examples:

- `LEGACY_FREE_TEXT_PLAN`
- `BIRTH_DATE_MISSING`
- `CRM_IDENTITY_REVIEW_PENDING`
- `EXISTING_PAYMENT_SCHEDULE_NOT_EVALUATED`
- `END_DATE_PASSED`
- an overlap in the same program (0624 guard)
- a lock timeout (`START_FAILED_55P03`)

Staff then use Start on the contact card, as before.

Two more cases always go to staff:

- A DRAFT created after the child already signed the current version waits for staff Start.
- Adults never take this path, because only guardians sign (0463).

## Evidence changes to 0177

Columns and checks are only added or widened, so no existing row changes.

| Item | Change |
|---|---|
| `decision_basis` | New value `AGREEMENT_SIGNED` |
| `signature_id` (new column, unique, FK to the signature) | Set exactly when the basis is `AGREEMENT_SIGNED` |
| `authorizing_permission` | `membership_agreement.signed` for a signing; staff decisions keep `billing.membership.activate`. The effective-period check is widened the same way. |
| `requirements_not_evaluated` | A signing decision no longer lists `AGREEMENT`. A staff decision still lists it. |
| Signing decision limits | No override, no adult attestation, reason `ROUTINE_ENROLLMENT` |
| Actor | The signer principal: the guardian in the portal, or the 0499 link principal for a link. Audit source is `HUMAN_UI` or `PUBLIC_API`. |

## Security boundary

- No new runtime entry point, and nothing is granted to any client role. Both functions are SECURITY DEFINER with a pinned search_path and are owner-only.
- The trigger sets the tenant context from the signature row and restores it afterwards. The per-membership function refuses to run if the context does not match the signature.
- The outcome table uses forced RLS with no policy or grant, and is immutable (the 0177 evidence guard).
- On purpose, the outcome table has no foreign key to `hon.memberships`. A key-share row lock could wait on a membership row that another transaction holds, and a DRAFT left for staff must never fail the signing.
- Nothing is charged, scheduled, invoiced, refunded or sent here, and no provider is called. Audit, outbox and outcome rows hold identifiers and codes only.

## Proofs

`test-membership-activates-on-signing-integrity.mjs` runs on the Champions Club fixture (8 groups). It covers posture and the verifier section, rollback, a start on the staff dates, date handling, left-for-staff reasons, a lock conflict, scope, and the widened checks.

The 0463 and 0499 agreement proofs still pass, and they exercise the trigger in both the portal path and the link path. The 0177 activation gate proof reviews the two new `hon.memberships` readers.
