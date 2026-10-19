# CRM enrollment migration lineage reconciliation

**Status:** Reconciled on the isolated `manus/crm-enrollment-workflow` branch pending full disposable-local validation and review. This note is a repository-integration safeguard; it neither authorizes a remote migration nor changes customer data.

## Why reconciliation was required

The CRM enrollment branch originally introduced four prospective migrations using numbers already claimed by the current `main` branch. `main` now owns the following historical filenames:

- `0152_champions_club_contests.sql`
- `0153_champions_club_integration.sql`
- `0154_hon_subscription_catalog.sql`
- `0155_hon_invoices_payment_evidence.sql`
- `0156_hon_premium_credit_accounting.sql`
- `0157_hon_refunds_champions_fulfillment.sql`

The CRM branch migrations therefore move forward, preserving their internal dependency order:

| Previous prospective filename | Reconciled prospective filename |
| --- | --- |
| `0152_flexible_billing_accounts.sql` | `0158_flexible_billing_accounts.sql` |
| `0153_crm_lead_registration.sql` | `0159_crm_lead_registration.sql` |
| `0154_staff_curriculum_enrollment_preparation.sql` | `0160_staff_curriculum_enrollment_preparation.sql` |
| `0155_crm_adult_membership_draft.sql` | `0161_crm_adult_membership_draft.sql` |

The resulting order leaves the adult membership DRAFT source dependency intact: `0159` creates immutable CRM registration conversion evidence before `0161` references it. `0158` remains before the adult relation proof that relies on canonical billing-account classification. `0160` remains independent.

## Safety boundary

HON's migration ledger records the **filename** as the migration identity. This reconciliation is safe only for a new database or a database already following `main` where the old CRM filenames were never applied. The CRM enrollment branch evidence to date uses disposable local fixtures only; it must not be treated as evidence that any persistent environment received the old files.

**Do not run the ordinary migration runner against a database that recorded any of these old CRM filenames:**

- `0152_flexible_billing_accounts.sql`
- `0153_crm_lead_registration.sql`
- `0154_staff_curriculum_enrollment_preparation.sql`
- `0155_crm_adult_membership_draft.sql`

Such an environment requires a separate, reviewed, environment-specific forward/baseline reconciliation that verifies both installed schema objects and `hon.schema_migrations` history before any main-line migration is applied. Never rename or replay historical applied migrations by assumption, and never use a local test fixture against a remote/shared database.

## Preserved work

The reconciliation retains both sides of the merge:

- CRM enrollment, flexible billing accounts, registration, curriculum preparation, and adult membership DRAFT contracts, guards, fixed-function/RLS boundaries, workbenches, proofs, and migration references.
- Current `main` Champions Club and HON SaaS subscription, invoicing, premium-credit, refund, and reward-accounting migrations, runtime grants, contracts, routes, tests, proof wiring, and approved Codex/visual artifacts.

The runtime grant reconciliation is an additive union: it does not introduce broad table access and retains each fixed-function boundary. Full migration, RLS, focused security, API/web, workspace, and disposable-proof validation remains required before this branch is reviewable.
