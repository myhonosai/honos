# Codex handoff: CRM guardian/child enrollment

Backend: branch `claude/project-thread-xsrj9t` (migration 0176), not merged. Contracts live in `packages/contracts/src/crm-guardian-child-enrollment.ts` and are exported from `@hon/contracts`. Use the shared validators and verifiers; do not re-implement them. Design and owner decisions: [CRM guardian/child enrollment](architecture/CRM_GUARDIAN_CHILD_ENROLLMENT.md).

This extends the connected CRM lead registration flow (PR #42) after a lead is registered on the `GUARDIAN_CHILD` path. Do not change the adult flow or its six Resume Setup states.

## Transport rules (all four routes)

Always `POST` with a JSON body, same-origin `fetch`, and `X-HON-Human-Command` set to the route's exact marker. Send no query string and no other `X-HON-*` header. Commands require a fresh UUID `Idempotency-Key` per new command; the read must not send one. Bodies are closed: any extra field returns 400. Organization, school and lead in the URL are selectors only; the server re-derives authority.

Prefix: `/v1/organizations/:organizationId/schools/:schoolId`.

| Route | Marker | Key | Body | `data` |
| --- | --- | --- | --- | --- |
| `crm/leads/:leadId/guardian-child-enrollment` | `crm-guardian-child-enrollment-read` | none | `{}` | `CrmGuardianChildEnrollment` |
| `crm/leads/:leadId/guardian-child-enrollment/payer-designation` | `crm-guardian-child-payer-designation` | required | `{ confirmation: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION }` | `CrmGuardianChildPayerDesignationReceipt` |
| `crm/leads/:leadId/guardian-child-enrollment/children` | `crm-guardian-child-addition` | required | `{ childGivenName, childFamilyName, childBirthDate: 'YYYY-MM-DD', confirmation: CRM_GUARDIAN_CHILD_ADDITION_CONFIRMATION }` | `CrmGuardianChildAdditionResult` |
| `billing/crm-guardian-child-membership-drafts/from-plan` | `crm-guardian-child-membership-draft-from-plan` | required | `{ studentProfileId, membershipPlanId, membershipPlanVersion, termStartedAt?, confirmation: CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION }` | `CrmGuardianChildMembershipDraftFromPlan` — `{ receipt, plan }` |

Plan options come from the existing adult route `billing/crm-adult-membership-drafts/plan-options` (marker `crm-adult-membership-plan-options`). The canonical account is created with the existing billing-account command, with `responsiblePersonId` set to the guardian's `sourceContactPersonId` from `historicalRegistrationReceipt`.

`meta` is `{ requestId, correlationId, replayed }`. `replayed: true` means the same key and input already succeeded and the returned data is that historical result: treat it as success and say it was already recorded.

Verify every response with `verifyCrmGuardianChildEnrollment(data, leadId)`, `verifyCrmGuardianChildPayerDesignationReceipt`, `verifyCrmGuardianChildAdditionResult(data, leadId, input)` or `verifyCrmGuardianChildMembershipDraftFromPlan(data, input)`. A verifier failure means "unknown result": show no assumed state and offer only an explicit retry with the **same** key and input.

## Screen: family enrollment (after GUARDIAN_CHILD registration, and on Resume setup)

Read on page entry or an explicit action; no polling. Drive the screen from `workflowState`:

| Family state | Show | Action |
| --- | --- | --- |
| `NOT_REGISTERED` | Not registered yet | Existing registration flow |
| `ADULT_REGISTRATION` | Adult registration | Existing adult Resume setup (0174) |
| `NEEDS_STAFF_REVIEW` | "This family needs staff review before enrollment can continue." No details, no merge or link controls | none |
| `BILLING_ACCOUNT_REQUIRED` | Guardian name, children | Create the guardian's billing account (existing command), then re-read |
| `PAYER_DESIGNATION_REQUIRED` | + account currency | Confirm the guardian as payer |
| `PAYER_DESIGNATED` | + designation receipt | Per-child DRAFTs; add another child |

The payer step must state who will be responsible ("{guardian.displayName} will be the billing contact for every child in this family") and require an explicit confirm. There is no payer, account or relationship picker: never derive or offer one from lead contact data.

Children list: `displayName`, `origin` (registered vs added) and child state:

| Child state | Show / action |
| --- | --- |
| `AWAITING_PAYER_DESIGNATION` | Waiting for the payer step |
| `READY_FOR_DRAFT` | Plan picker → DRAFT (same flow as the adult plan picker: currency must equal `billingAccount.currency`, fixed-term end is a preview only) |
| `CURRENT_DRAFT` | The DRAFT receipt and "created from" plan version terms (`currentMembershipDraft.receipt` / `.plan`) |
| `CURRENT_DRAFT_BY_OTHER_STAFF` | "A DRAFT was already recorded by another staff member." No details |
| `NEEDS_STAFF_REVIEW` | Needs staff review; no action |

Add another child: given name, family name and birth date, explicit confirm, up to 10 children per family. `{ outcome: 'NEEDS_STAFF_REVIEW' }` means a possible existing record (including twins of an enrolled child): nothing was created; say so and offer no merge. On `CHILD_ADDED`, re-read the family.

## Errors

| Status / `code` | Show |
| --- | --- |
| 403 `CRM_GUARDIAN_CHILD_ENROLLMENT_FORBIDDEN` | Access lost: clear the panel |
| 404 `CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE` | Not available for this lead (already designated, already drafted, drifted, adult or unregistered); re-read |
| 409 `CRM_GUARDIAN_CHILD_BILLING_ACCOUNT_REQUIRED` | Create the guardian's billing account first |
| 409 `CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_REQUIRED` | Designate the payer first |
| 409 `CRM_GUARDIAN_CHILD_LIMIT` | The family has the maximum of 10 children |
| 409 `MEMBERSHIP_PLAN_VERSION_STALE` | The plan changed; reload options and require a fresh review. Never auto-resend |
| 409 `MEMBERSHIP_PLAN_CURRENCY_MISMATCH` | Plan currency differs from the guardian's account |
| 404 `MEMBERSHIP_PLAN_UNAVAILABLE` | The plan is no longer offered; reload |
| 409 `IDEMPOTENCY_KEY_REUSED` | Client bug: new command, new key |
| 409 `CRM_GUARDIAN_CHILD_ENROLLMENT_CONFLICT` | No change assumed; allow an explicit retry |
| 400 `INVALID_CRM_GUARDIAN_CHILD_ENROLLMENT_INPUT` / `CRM_GUARDIAN_CHILD_SELECTORS_NOT_ACCEPTED` | Validation (prevent client-side) |
| 503 / malformed | Unknown result; exact retry only |

## Boundaries

No schedule, invoice, payment, charge, agreement, consent, discount, communication or activation exists here, and the UI must not imply one. Prices are "published price", never a charge or balance. No child, guardian, receipt or key data enters URLs, storage or telemetry. Keep the immutable input and key in memory only for an exact retry.
