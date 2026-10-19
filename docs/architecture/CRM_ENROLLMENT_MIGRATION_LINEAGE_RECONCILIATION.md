# CRM enrollment migration lineage reconciliation

**Status:** Reconciled on the isolated `manus/crm-enrollment-workflow` branch. Full disposable-local validation and read-only review passed; pull-request CI remains required before merge. This note is a repository-integration safeguard; it neither authorizes a remote migration nor changes customer data.

## Why reconciliation was required

The CRM enrollment branch first reconciled four prospective migrations around historical names already claimed by `main`. Before CRM PR #27 could merge, `main` then merged B5 and claimed the next available filename. `main` now owns the following historical filenames, all retained byte-for-byte:

- `0152_champions_club_contests.sql`
- `0153_champions_club_integration.sql`
- `0154_hon_subscription_catalog.sql`
- `0155_hon_invoices_payment_evidence.sql`
- `0156_hon_premium_credit_accounting.sql`
- `0157_hon_refunds_champions_fulfillment.sql`
- `0158_hon_payment_provider_test_mode.sql`

B5 is the authoritative test-mode-only payment-provider migration. It is deliberately unrelated to school-to-family billing-account, CRM-registration, curriculum-enrollment, and adult-DRAFT data, and must never be replaced, renamed, or edited as part of CRM reconciliation.

The five currently prospective CRM migrations therefore move forward as follows, preserving their dependency order:

| Former prospective filename | Reconciled prospective filename |
| --- | --- |
| `0158_flexible_billing_accounts.sql` | `0159_flexible_billing_accounts.sql` |
| `0159_crm_lead_registration.sql` | `0160_crm_lead_registration.sql` |
| `0160_staff_curriculum_enrollment_preparation.sql` | `0161_staff_curriculum_enrollment_preparation.sql` |
| `0161_crm_adult_membership_draft.sql` | `0162_crm_adult_membership_draft.sql` |
| `0162_crm_adult_membership_draft_confirmation.sql` | `0163_crm_adult_membership_draft_confirmation.sql` |

The resulting order is deliberate:

1. `0159` establishes canonical/additional billing-account classification before the adult relation proof needs the canonical account.
2. `0160` creates immutable CRM registration conversion evidence before `0162` references it.
3. `0161` is independent curriculum-enrollment preparation and shifts only to preserve one unambiguous lexicographic ledger.
4. `0162` creates the immutable conversion-to-membership source evidence before `0163` can confirm its current DRAFT state.

## Safety boundary

HON's migration ledger records the **complete filename** as the migration identity. This rename is safe only for a fresh database or for a database following `main` in which none of the former CRM filenames below were ever recorded. Existing validation was restricted to disposable local fixtures and must not be interpreted as evidence that a persistent environment received any former CRM file.

**Do not run the ordinary migration runner against a database that recorded any former prospective CRM filename:**

- `0152_flexible_billing_accounts.sql`
- `0153_crm_lead_registration.sql`
- `0154_staff_curriculum_enrollment_preparation.sql`
- `0155_crm_adult_membership_draft.sql`
- `0158_flexible_billing_accounts.sql`
- `0159_crm_lead_registration.sql`
- `0160_staff_curriculum_enrollment_preparation.sql`
- `0161_crm_adult_membership_draft.sql`
- `0162_crm_adult_membership_draft_confirmation.sql`

Such an environment requires a separate, reviewed, environment-specific forward/baseline reconciliation that first verifies installed schema objects and `hon.schema_migrations` history. Never rename or replay a historical applied migration by assumption, and never use a local test fixture against a remote/shared database.

## Preserved work

This reconciliation retains both sides of the merge:

- CRM enrollment, flexible billing accounts, registration, curriculum preparation, adult membership DRAFT, and current-DRAFT confirmation contracts, guards, fixed-function/RLS boundaries, workbenches, proofs, and migration references.
- Current `main` Champions Club, HON SaaS subscription/invoicing/premium-credit/refund/reward accounting, B5 test-mode payment-provider migration and implementation, runtime grants, contracts, routes, tests, proof wiring, and approved Codex/visual artifacts.

Runtime-grant reconciliation is an additive union. It does not introduce broad table access, and it retains each fixed-function boundary. Fresh complete-chain migration, RLS/security proof, focused API/web, workspace, and pull-request CI validation remain required before this branch is reviewable.
