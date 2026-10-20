# CRM adult registration → membership DRAFT: integration onto current main

**Status:** Integration branch `claude/crm-pr27-integration-jt8qd6`, based on `main` at `963a4d7` (B6A). Not deployed. No remote database, payment provider, customer communication or merge. Manus PR [#27](https://github.com/myhonosai/honos/pull/27) and the `manus/crm-enrollment-workflow` branch are left untouched.

## What was taken from PR #27

Source commit: `22211bf` on `manus/crm-enrollment-workflow` (the adult-workflow state whose CI run 39204752220 passed). The later guardian/child commit `36c2ab1` is deliberately excluded. Every taken file is byte-identical to PR #27 unless listed under "Changes made here".

| Layer | Files |
| --- | --- |
| Migrations | `0159_flexible_billing_accounts.sql`, `0160_crm_lead_registration.sql`, `0162_crm_adult_membership_draft.sql`, `0163_crm_adult_membership_draft_confirmation.sql` |
| Contracts | `crm-lead-registration.ts`, `crm-adult-membership-draft.ts`, billing-account input/classification in `index.ts` |
| API | lead registration controller/service/DTO; adult membership draft controller/service/DTO; billing-account guard, payer lookup, classification and explicit additional-account command |
| Runtime grants | exact reconciliation and verification blocks in `infra/postgres/010` and `011` |
| Proofs | flexible billing accounts, CRM lead registration, adult membership DRAFT (setup, local guard, security verifier, integrity proof) |
| Docs | `HUMAN_FLEXIBLE_BILLING_ACCOUNTS.md`, `FLEXIBLE_CRM_ENROLLMENT_FAMILY_BILLING_POLICY.md`, `HUMAN_CRM_LEAD_REGISTRATION.md`, `CRM_ADULT_MEMBERSHIP_DRAFT.md`, `CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION.md` |

The DRAFT reuses the existing `hon.memberships`, `hon.billing_accounts` and `hon.membership_payment_schedules` domain. No second membership, billing or payment system is introduced, and nothing here touches the HON SaaS subscription/payment tables (B1–B6A).

## Migration numbering and compatibility

`main` already reserved this range: `HON_PAID_ACCESS_B6_PROPOSAL.md` records CRM #27 as `0159–0167` and B5.1 took `0170`. Gaps are allowed because the runner applies files in sorted order and records the full filename.

- Filenames are kept **exactly** as PR #27 names them. A disposable database that applied PR #27's current files therefore has identical ledger entries and identical SQL; nothing is renamed or rewritten.
- `0158`, `0172` and `0173` (and every other file on main) are unchanged.
- `0161` (curriculum enrollment preparation) is intentionally absent, leaving a gap. If it lands later under its PR #27 name it sorts before `0162`, but it only creates two read functions and depends on nothing in `0162`/`0163`, so a database that already applied `0162`/`0163` can apply it afterwards. `0151` (CRM intake-stage read) is the same: independent read functions in a reserved gap.
- Databases that recorded PR #27's **older** CRM filenames (`0152_flexible_billing_accounts.sql` … `0162_crm_adult_membership_draft_confirmation.sql` as listed in `CRM_ENROLLMENT_MIGRATION_LINEAGE_RECONCILIATION.md` on the Manus branch) must not run the ordinary runner; they need a reviewed environment-specific baseline. No persistent environment is known to have applied them.

## Changes made here (beyond copying)

1. `migrate.mjs`: loopback detection for `127.0.0.1`/`[::1]` (the adult fixture's isolated cluster), the flexible-billing runtime alias, and the flexible-billing stop point moved from `0151` (not on this branch) to `0158`, so the legacy-row backfill proof still inserts rows before `0159`.
2. `infra/postgres/010`: an exact grant block for the two `0159` billing-account authority functions. The canonical baseline revokes every `hon` function from the runtime, so without it re-running `010` after `0159` would break billing-account creation.
3. Flexible billing proof/verifier: the "unrelated helper must stay ungranted" check now uses `hon.require_crm_lead_close_actor(text)` (on main) instead of the intake-stage helper from `0151`.
4. `run-db-proofs.sh`: CI now runs the flexible-billing, lead-registration and adult-DRAFT proofs (the adult proof in its own mode-0700 loopback cluster).

## B6A compatibility

The new runtime entry points require an `ACTIVE`, in-effect organization entitlement, the same rule `0172` applied to the six staff resolvers. The B6A behavioural coverage proof (`test-entitlement-enforcement-coverage.mjs`) runs over the full migration chain including these files and passes with no new allowlist entry or recorded gap.

## Left for separate tasks

- Guardian/child payer designation and membership DRAFT (`0164`–`0167`, PR #27 head `36c2ab1`).
- Curriculum enrollment preparation (`0161`) and CRM intake-stage read (`0151`) with their APIs.
- All staff web workbenches from PR #27 (frontend is owned by Codex).
- Membership activation/payment after DRAFT, public signup, production payment processing.
