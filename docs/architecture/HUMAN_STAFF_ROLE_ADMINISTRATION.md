# Human staff role administration

## Inspected foundation

Migration 0001 and the live database agree: `hon.roles` is organization-owned (`code` unique within organization, `is_system_role`); `hon.role_permissions` maps roles to globally defined permission codes; `hon.principal_role_grants` binds a principal/role to exactly one school with effective dates. Existing grants had no version or explicit revocation metadata. Ordinary runtime has **no direct IAM/directory privileges**. The fixed `resolve_authorized_scope` bridge derives an active HUMAN_USER from a verified external subject. HQ provisioning (0022) creates **one system OWNER role and one initial human OWNER grant**, and seeds that role from all current permission definitions.

Migrations 0059–0061 preserve that bootstrap and safely add permissions to **existing canonical system OWNER roles only**. No existing non-OWNER roles or principal grants are mass-upgraded. New custom roles add `management_school_id` plus version; grants add version/revocation metadata. Role-permission RLS is now enabled and forced. The live predicate recognizes explicit revocation and uses a live clock after lock waits.

## Exact sensitive permission/action codes

| Permission | Action |
| --- | --- |
| `iam.custom_role.create` | `iam.custom_role.create` |
| `iam.custom_role.update` | `iam.custom_role.update` |
| `iam.staff_role.grant` | `iam.staff_role.grant` |
| `iam.staff_role.revoke` | `iam.staff_role.revoke` |
| `iam.staff_role.manage` | Access gate for every mutation and read |

All five permissions are sensitive. IAM actions are **deliberately absent from the Action Engine/Tool Gateway executable catalog**. The same human service cannot accept AI, automation, integration, PUBLIC_API, action-request or delegated contexts.

## API and human UI

Base: `/v1/organizations/:organizationId/schools/:schoolId/staff-roles`.

| Endpoint | Closed body |
| --- | --- |
| `POST /custom` | `code`, `name`, `permissionCodes` |
| `POST /custom/:roleId/update` | `name`, `permissionCodes`, `expectedVersion` |
| `POST /grants` | `roleId`, `targetPrincipalId`, `targetExternalSubject`, optional `effectiveUntil` |
| `POST /grants/:grantId/revoke` | `expectedVersion` |
| `GET /custom/:roleId` | None; known-ID custom/non-system role projection |
| `GET /grants/:grantId` | None; known-ID non-system grant projection |

Writes return HTTP 200 with `{ data, meta: { requestId, correlationId, replayed } }`. Each write requires a bounded `Idempotency-Key`. Tenant/actor/source/request IDs cannot be supplied in a body. Guarded session resolution checks route organization and school; SQL re-resolves the verified subject against transaction-local identity-derived context and live permissions.

The conventional UI lives at **`/staff/roles`**, using same-origin `/api/v1` rewrites. It uses exact forms, not a generic SQL/table/payload editor. IDs must already be known through an authorized registration/onboarding process. There is **no search/list/directory endpoint**. The page makes no identity lookup before authorization and does not store subjects in local storage, logs or outbox. Uncertain identical retries reuse their command key.

For sensitive cookie-authenticated writes, configure **`HON_PUBLIC_ORIGIN` to the exact trusted web origin** (HTTPS in deployment). The dedicated guard requires that Origin, JSON and `X-HON-Human-Command: staff-role-admin`; cross-site Fetch Metadata is rejected. Missing trusted origin fails closed with 503. This header is CSRF defense, not authentication or permission. Reads still require a verified human session and live scoped manage authority. There are no tenant client database grants.

## Roles and targets

- Custom codes must match `CUSTOM_[A-Z][A-Z0-9_]{1,47}`; organization uniqueness prevents duplicate codes. Reserved OWNER/HON/HQ/platform/system codes and `is_system_role` are never client-selectable.
- `permissionCodes` must be a nonempty, bounded, unique set of existing codes in the **closed `is_staff_assignable` allowlist**. Future definitions default unassignable. Every proposed permission must be in the actor's **current effective permissions at this school**. Updates check the old set too.
- New roles are usable/manageable at exactly their creating school. Existing non-system organization roles can be granted at an authorized school but **cannot be edited** via this endpoint. Updates cannot touch another school's role/recipients or an actor's own still-relevant assignment. The recipient guard locks/revalidates registered human recipients and denies HQ/system/non-human/inactive targets, including indirect role updates.
- Granting requires **both** an already-known target principal UUID and exact registered external subject. The private fixed resolver matches one unambiguous, active HUMAN_USER, locks principal/user records, rejects self, any HQ grant history and active system/privileged role targets. It returns only a UUID to the command. No email/phone registration, invitations or contact search occurs. Ordinary runtime cannot execute this resolver directly.
- Grants start immediately at the database clock. Expiry is optional; if supplied, it must be a finite timezone-qualified timestamp **after now and within 90 days**. No future start, scope widening or bulk assignment is supported. A second live/future duplicate assignment is rejected unless replaying the original command key.

## Revocation and ownership

Revocation is a **versioned end**, never DELETE. Active grants are ended at the live database clock, receive `revoked_at`/`revoked_by_principal_id`, and increment version. Already-ended/expired grants are no-ops with no second audit/outbox; future grants cannot be ended through this active-grant endpoint. Exact-key replay requires current actor authorization and returns the historical result before stale-version rejection.

**All system OWNER/system/HQ/platform role mutations are denied**. OWNER-equivalent custom roles are determined by inclusion of the canonical OWNER role's actual permission set. Their edits are denied, and revocation cannot remove the final active human OWNER-equivalent grant coverage at that school. Equivalence is permission-set based, not a display name. Organization serialization makes the final-coverage check atomic across concurrent commands. No ownership transfer is introduced. Existing invalid/missing owner topology is not silently repaired.

Current scope intentionally refuses even revocation involving inactive/non-human/HQ/system targets: this tenant slice is not privileged IAM cleanup. Such changes require a separately reviewed control-plane process.

## Atomicity and least privilege

`StaffRoleService` opens the ordinary restricted transaction with local RLS context and bounded HUMAN_UI attribution. The fixed command locks the active organization (serialization across all IAM writes), actor/school/actor grants/roles, selected role/grant and eligible target. Explicit composite organization/school predicates mirror forced RLS inside the audited definer; definer access is an IAM bridge, never an arbitrary query facility. Subset/live-authorization checks execute after locks, using a fresh clock, including after waits.

Mutation, SHA-256 request fingerprint, idempotency reservation/completion, append-only audit and transactional **inert outbox** all commit or roll back together. Each real transition has prior/next state and one action-coded HUMAN_UI audit plus one `iam.*` outbox event; replay/no-op does not duplicate evidence. Target contacts/subjects are absent from evidence. Infrastructure failures are not reported as successful changes.

Only `mutate_staff_role` and `read_staff_role` receive new runtime EXECUTE. Global users/principals/roles/permissions/role-permissions/grants and HQ tables remain unavailable for direct runtime SELECT or mutation. All functions have a fixed `pg_catalog, hon` search path, PUBLIC revoked, and the private target/recipient helpers are non-executable by runtime. The canonical Supabase setup/verifier preserves those rights.

## Explicit exclusions and remaining work

No payroll; autonomous hiring/firing/discipline; identity registration; external invitations; messaging delivery; provider calls; Action Engine/AI execution; workers/consumers; people, billing, schedules or work-item mutations. Role changes are authorization facts, **not employment decisions**. Outbox events do not activate a delivery consumer.

Future work: separately reviewed ownership transfer/control-plane cleanup, registered-staff profile presentation, broader workforce availability/time-off/certification features, and authorized onboarding discovery. Security is not tier-gated.

## Validation

`pnpm db:test-staff-roles` builds and runs real admin/restricted-runtime fixtures; `pnpm test`, `pnpm check`, `pnpm build`, `pnpm db:check`, `pnpm db:verify-rls` cover shared contracts, API guards/DTOs, UI build, migrations and RLS. Tests prove same/cross-school/org denial, exact targets, privileged/HQ/system protection, role subset, no self-mutation, scope/expiry/ending/replay/concurrency, directory SELECT denial, rollback of business/audit/outbox/key together and unchanged prohibited tables. All fixtures are removed with migration credentials; no runtime directory grants are added for testing.
