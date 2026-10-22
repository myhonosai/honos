# Owner Launch / CRM / billing: canonical lock order (migration 0169)

**Status:** PR #41 branch `claude/crm-pr27-integration-jt8qd6`. Not deployed. Evidence comes from disposable localhost PostgreSQL only.

## Canonical order

Every command in this family acquires its locks in this order and never goes back to an earlier level:

| Level | What | Mode |
| --- | --- | --- |
| 0 | Its own idempotency key, where the command has one: an `IN_PROGRESS` row reservation (`INSERT … ON CONFLICT DO NOTHING`), then `FOR UPDATE` of that row on replay | ROW EXCLUSIVE + row lock. Never a table lock on `idempotency_records` |
| 1 | IAM and entitlement tables (`users`, `principals`, `principal_role_grants`, `roles`, `role_permissions`, `permissions`, `family_access_grants`, `hq_operator_grants`, `organizations`, `schools`, `organization_entitlements`) | SHARE only. This blocks grant and entitlement writers until commit and never blocks another reader, so the order inside the level does not matter |
| 2 | Domain tables, in this fixed order: `people`, `student_profiles`, `families`, `family_members`, `crm_lead_registration_conversions`, `crm_leads`, `student_curriculum_enrollments`, registration receipts, `billing_accounts`, `memberships`, `crm_adult_membership_draft_sources`, `crm_guardian_child_enrolled_children`, `crm_guardian_child_payer_designations`, `crm_guardian_child_membership_draft_sources` (0176), `membership_plans`, `membership_plan_versions`, `membership_plan_selections` (0175), `membership_payment_schedules`, `invoices` | Writers use SHARE ROW EXCLUSIVE (or ROW EXCLUSIVE inserts). Confirmations use SHARE. A row already frozen by its table lock is read without `FOR UPDATE` |
| 3 | Append-only evidence: `audit_events`, `outbox_events` | Written last. A reader that locks `audit_events` locks it last |

## Workflow audit (after 0169)

| Workflow | Lock sequence |
| --- | --- |
| Owner Launch student / guardian-child registration (0133/0134, unchanged) | IAM SHARE (alphabetical) → registration advisory lock → `programs`, `class_sessions` FOR SHARE rows → `people`, `student_profiles` SRE → inserts (people, families, family members, profile, enrollment, receipt) → audit, registration outbox |
| Owner Launch membership DRAFT (0138, unchanged) | IAM SHARE → FOR SHARE on the receipt's rows → `billing_accounts`, `memberships` SRE → idempotency row → inserts → audit, outbox → idempotency update. **The one exception: key after tables** (see residuals) |
| Owner Launch DRAFT confirmation (0139 → **0169**) | IAM SHARE → SHARE on people … invoices in canonical order → `audit_events` SHARE last |
| Owner Launch booking context (0140, unchanged) | IAM SHARE → SHARE on `idempotency_records` (level 0), programs, sessions, bookings, people … receipts → `audit_events` last |
| CRM registration (0160 → **0169**) | IAM **SHARE** → people, student_profiles, families, family_members, conversions SRE → lead row FOR UPDATE → inserts → audit, outbox |
| Adult CRM DRAFT (0162 → 0168 → **0169**) | idempotency row reservation → IAM **SHARE** → people … DRAFT sources SRE → inserts (membership, source) → audit, outbox → idempotency update. Replay reads the source and membership rows without row locks |
| Adult CRM DRAFT confirmation (0163, unchanged) | IAM SHARE → people … invoices SHARE in canonical order |
| Billing-account create (service + 0159) | idempotency row → `billing_accounts` SRE → insert → audit, outbox → idempotency update |
| Membership create (service) | idempotency row → `memberships` insert (FK key-share on account and person rows) → schedule → audit, outbox → idempotency update |
| Membership activation (service) | membership row FOR UPDATE → idempotency row → membership update → audit, outbox → idempotency update |
| Membership plan create / revise (0175) | idempotency row reservation → IAM SHARE → `membership_plans`, `membership_plan_versions` SRE → inserts (head, version) / version insert + head update → audit, outbox → idempotency update |
| Adult CRM DRAFT from plan (0175) | idempotency row reservation → IAM SHARE → the exact 0169 DRAFT set SRE → `membership_plans`, `membership_plan_versions` SHARE → inserts (membership, source, selection) → audit, outbox → idempotency update |
| Guardian/child family read (0176) | IAM SHARE → people … memberships, guardian/child tables, `membership_payment_schedules`, `invoices` SHARE in canonical order |
| Guardian payer designation (0176) | idempotency row reservation → IAM SHARE → people … `billing_accounts`, `crm_guardian_child_payer_designations` SRE → insert, member projection update → audit, outbox → idempotency update |
| Guardian additional child (0176) | idempotency row reservation → IAM SHARE → the 0169 registration set + `crm_guardian_child_enrolled_children` SRE → inserts → audit, outbox → idempotency update |
| Guardian child DRAFT from plan (0176) | idempotency row reservation → IAM SHARE → the 0169 DRAFT set (people … memberships) SRE → enrolled children, designations SHARE → child DRAFT sources SRE → `membership_plans`, `membership_plan_versions` SHARE → inserts → audit, outbox → idempotency update |
| CRM lead close (0145, unchanged) | IAM SHARE → lead row FOR UPDATE → lead update → audit, outbox |

**Triggers and helpers.** Triggers on these tables only guard immutability or capture lead attribution on lead insert/update; none takes a table lock. `lock_owner_launch_actor` and `lock_current_direct_human_billing_accounts` are covered above. Foreign-key checks take KEY SHARE row locks, which conflict only with `FOR UPDATE` row locks. 0169 removes the DRAFT's redundant `FOR UPDATE` on billing-account, conversion, source and membership rows, so no FK check waits on them.

## Cycles found and fixed (all reproduced before the fix)

1. **Reported: Owner Launch DRAFT vs adult CRM DRAFT.** 0168 held SHARE ROW EXCLUSIVE on the whole `idempotency_records` table, then waited for SHARE ROW EXCLUSIVE on `users`. Owner Launch DRAFT holds `users` in SHARE and then inserts its idempotency row. Fix: the DRAFT reserves only its own key row.
2. **IAM order inversion.** 0160 and 0168 took IAM tables in SHARE ROW EXCLUSIVE in `users`-first order, while every Owner Launch command takes the same tables in SHARE in alphabetical order. This deadlocked CRM registration and the DRAFT against Owner Launch registration, the Owner Launch DRAFT, its confirmation and the booking context. Fix: IAM is SHARE-only everywhere.
3. **Owner Launch DRAFT confirmation vs registration writers.** 0139 took SHARE on `audit_events` and the receipts before `people`/`student_profiles`, while every registration writer holds `people`/`student_profiles` and appends its audit row last. This was a pre-existing Owner Launch cycle on main (registration vs confirmation). Once 0169 makes the CRM DRAFT IAM-compatible, the same inversion would also hit the DRAFT through `billing_accounts`. Fix: the same tables and mode in canonical order, with `audit_events` last.
4. **DRAFT replay vs membership activation.** The replay row-locked the membership under its `memberships` table lock. An activation that already holds that row then waits for the table. Fix: the replay reads the frozen row without a row lock.

Bodies are otherwise verbatim. Authorization (including the post-lock actor re-check), RLS, uniqueness, fingerprints, replay and conflict outcomes, receipts, audit, outbox and rollback are unchanged.

## Evidence

`test-crm-owner-launch-lock-order-integrity.mjs` runs on the flexible-billing fixture in CI. It covers 11 workflows. Each one is paused at every lock stage, either by a blocker holding EXCLUSIVE on the next table or by a statement gate, while every other workflow arrives on independent data. That makes 440 interleavings, covering both arrival orders of every pair. The waits-for graph is sampled until both sides finish.

- **Pre-0169 bodies, re-installed in the disposable database:** 27 of 440 interleavings fail. Each failure is an observed wait cycle that PostgreSQL resolves as a deadlock. They include the reported pair, and replay vs held activation also cycles.
- **Ablations:** the 0169 CRM bodies with the old confirmation order still cycle. A 0169 DRAFT that keeps the replay row lock still cycles with activation.
- **0169:** all 440 interleavings commit with their exact outcomes. Same-key, same-adult and key-reuse DRAFT races and replay vs activation leave exactly one membership, source, audit and outbox row. No idempotency reservation is left unfinished.

**Owner Launch unchanged.** `test-owner-launch-integrity.mjs` now runs in CI on its own fixture and passes with 0169: 102 assertion groups covering registration, guardian/child, booking, membership DRAFT and both confirmations. Running it surfaced a break introduced earlier in this PR, not by 0169. Two Owner Launch proof fixtures inserted a second account for the same payer directly. 0159's one-canonical-account index now refuses that insert, so those fixtures now insert the second account as `ADDITIONAL`. The Owner Launch functions still see two accounts for the payer and return the same staff-review outcome.

**0174 addition.** The read-only CRM registration recovery (`read_crm_lead_registration_recovery`) takes the 0163 confirmation's SHARE set in the same canonical order and joins the matrix as a twelfth workflow paused at five lock stages: 540 interleavings, all committing with 0169 bodies (local disposable run). Against the pre-0169 bodies 27–28 of 540 fail depending on timing; none of those failures involves the recovery read.

**0175 addition.** The plan-bound adult DRAFT and the membership plan revision join the matrix as workflows 13 and 14, paused at six and three lock stages: 756 interleavings, all committing with 0169 bodies (local disposable run). Against the pre-0169 bodies 30 of 756 fail; the new failures pair the plan-bound DRAFT with the pre-0169 Owner Launch DRAFT confirmation order, exactly like the free-text DRAFT, and none occur with 0169.

**0176 addition.** The guardian/child family read, payer designation, additional child and child DRAFT from plan join the matrix as workflows 15–18, paused at four, five, four and seven lock stages: 1,332 interleavings of 18 workflows, all committing with 0169 bodies (local disposable run, about 7 minutes). The 0176 functions did not exist before 0169, so the pre-0169 matrix and the confirmation ablation keep the 14 legacy workflows (756 cells, 30 failures as before). The registration snapshot trigger runs inside the registration transaction and takes no table lock. The CI database-proof job timeout is 25 minutes.

**0177 addition.** Membership activation is now one protected function (`hon.activate_school_membership`) in the canonical order: key reservation, IAM SHARE, the CRM identity tables and billing accounts SHARE, memberships ROW EXCLUSIVE and then the row `FOR UPDATE`, the CRM DRAFT source and plan tables SHARE, then decision, period, membership, work items, follow-ups, audit and outbox. The lock-free read-only preview runs first. In the matrix the activation is paused at seven stages (`idempotency_records`, `users`, `people`, `memberships`, `crm_adult_membership_draft_sources`, `membership_activation_decisions`, `audit_events`): 1,422 interleavings across 18 workflows all commit. Because 0177 takes ROW EXCLUSIVE before the row lock, the pre-0177 "DRAFT replay vs held activation" cycle no longer forms, even against the pre-0169 bodies or a replay that row-locks the membership. The matrix now asserts that no cycle forms, where it used to assert that one did.

## Known residuals (not fixed here)

- **One principal reusing one idempotency key concurrently for an Owner Launch DRAFT and an adult CRM DRAFT.** Owner Launch reserves its key after its table locks, and every other command reserves it first. PostgreSQL may abort one side with `40P01`: CRM maps this to 409, while Owner Launch returns recoverable 503 with exact-request/key retry guidance. The residual proof asserts one fulfilled command, one idempotency row and no unfinished reservation; complete loser-side record counts and actual error-status assertions remain a backend test follow-up. Transaction rollback is verified separately. Fixing the lock-order exception means moving the Owner Launch DRAFT reservation ahead of its locks, which changes an Owner Launch body this task was asked to preserve.
- **IAM administrative writers** (role, grant and entitlement changes) take ROW EXCLUSIVE on IAM tables. A writer that updates two IAM tables in the opposite order to a SHARE reader's list could still cycle with that reader. This pattern predates this PR and is unchanged by it: 0169 only removes SHARE ROW EXCLUSIVE from IAM.
- **Guardian/child CRM port (0164–0167, not on this branch).** Its PR #27 bodies take IAM in SHARE ROW EXCLUSIVE. Porting them must follow this order.

## Persistent-database deployment risks

- 0169 is additive (`CREATE OR REPLACE` of three functions in one transaction). Owner, SECURITY DEFINER, `search_path` and ACL are kept, and `011` verifies the new bodies by hash.
- Applying it takes a brief exclusive lock on each function's catalog entry. In-flight calls finish on the old body, so apply it during a quiet window.
- An environment that applied 0168 has the cycle until 0169 is applied, and Owner Launch DRAFT and CRM DRAFT should not run concurrently there. No persistent environment is known to have applied 0159–0168.
- The PR #27 filename gate in `migrate.mjs` still applies.
