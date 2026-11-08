# U6 school-wide membership list (0220)

`GET /v1/organizations/:organizationId/schools/:schoolId/billing/memberships?limit=&cursor=&state=`

This read lists every membership of the verified school, newest first. Each row has its lifecycle state and its reporting status. It writes nothing and exposes no money, payer, agreement, consent or reason facts.

## Why a database function

Runtime can SELECT `hon.memberships`, but not the confirmed-date evidence in `membership_effective_periods` and `membership_date_revisions`. Those tables are private by design (0177 and 0178). A row's reporting status depends on that evidence, so migration 0220 adds one read-only SECURITY DEFINER projection, `hon.read_school_membership_list(subject, p)`. It is the only runtime boundary. Runtime has EXECUTE on it and on nothing new besides. The 010 grant block and the 011 exact verification (body hash, owner, ACL) pin it.

## Authority

- **Controller check:** admits the request when `resolveAuthorizedScope` passes at the route school for any one of `billing.membership.read`, `billing.membership.activate` or `billing.membership.dates.revise`, and the route's organization and school equal the verified scope. This is the same set as the per-membership date history read. URL values are not authority.
- **Database decision:** the definer function decides again, independently. It uses `hon.require_membership_lifecycle_actor` with the same three permissions, which checks:
  - a direct human (HUMAN_USER, HUMAN_UI, no action request, no delegation) with exactly one active principal;
  - no HQ, family or parent-style role;
  - eligible staff with the live school-scoped grant;
  - an ACTIVE organization and school, and an ACTIVE ESSENTIAL, CORE or COMPLETE entitlement.
- **Recheck:** after building the page, the function repeats the check and refuses if access changed meanwhile.
- **Every page:** all checks run on each page, so a permission removed, or a school, organization or entitlement suspended, refuses the next page.
- **Refusals:** 403 MEMBERSHIP_LIST_FORBIDDEN, or 403 HUMAN_COMMAND_REQUIRED for a non-human context. Browser-only selectors also apply: a cross-site request or an `x-hon-source` header returns 403 HUMAN_UI_REQUIRED.
- The response carries `Cache-Control: private, no-store`.

## Order, filter, paging

- **Order:** `created_at DESC, id DESC`. `created_at` is immutable, so the cursor carries the exact microsecond and the id directly. No anchor lookup is needed.
- **Filter:** `state` optionally narrows the list to one lifecycle state: DRAFT, ACTIVE, FROZEN, CANCELLATION_PENDING, CANCELLED or EXPIRED.
- **Limit:** 1 to 100, default 50.
- **Cursor:** the signed list cursor (`CRM_LIST_PAGINATION.md`), with list `billing.membership.list`, bound to the school and the `{ state }` filter. A cursor from another school, another filter or another list is refused with 400 INVALID_CURSOR. So is a tampered or truncated one.

## Response

```json
{
  "data": [{
    "membershipId": "…", "state": "ACTIVE", "version": 2, "planCode": "ADULT-MONTHLY", "billingAccountId": "…",
    "participant": { "personId": "…", "givenName": "…", "familyName": "…" },
    "effectiveStatus": "IN_EFFECT", "datesConfirmed": true,
    "currentPeriod": { "periodVersion": 1, "changeKind": "INITIAL", "startDate": "2026-11-08", "endDate": "2026-12-08" },
    "legacyStoredTerm": null,
    "createdAt": "2026-11-08T17:00:00.000Z"
  }],
  "meta": { "requestId": "…", "correlationId": "…", "limit": 50, "nextCursor": null, "schoolTimezone": "America/Los_Angeles", "localToday": "2026-11-08" }
}
```

- **`effectiveStatus`:**
  - For an ACTIVE membership: SCHEDULED, IN_EFFECT or ENDED, from its confirmed period, or UNDATED when it has none.
  - For every other state: the lifecycle state itself.

  It is derived exactly as in `hon.read_membership_date_history`.
- **`currentPeriod`:** school-local inclusive dates, present only when the dates are confirmed.
- **`legacyStoredTerm`:** the stored instants, given as hints only when the dates are not confirmed.
- **`participant`:** null if the person row is not visible in the school.
- **Types:** `@hon/contracts` (`school-membership-list.ts`). The API verifies every database page strictly and returns 503 for anything unverified.

## Proof

`packages/database/scripts/test-school-membership-list-integrity.mjs` is in `.github/scripts/run-db-proofs.sh`, on the crm-lead-close fixture. It runs the socket-free target guard negatives first and connects only to the guarded disposable target. It then drives signed HTTP through the real Nest app.

**Fixture:**
- 48 school-A memberships:
  - three activated through the real two-step activation service (SCHEDULED, and IN_EFFECT both with and without an end date);
  - 30 DRAFT rows sharing one `created_at` microsecond;
  - ten rows one microsecond apart;
  - legacy ACTIVE rows (UNDATED) with and without stored instants;
  - one row in each other lifecycle state.
- Rows of school B and of another organization that must not appear.

**What it checks:**
- Every membership once, in order, at limits 100, 50, 7 and 1, with the exact row facts.
- For every row, `effectiveStatus`, `datesConfirmed` and the period facts equal the 0178 history read.
- The state filter returns exactly that state's rows, and cursors are bound to the school and the filter. Tampered, truncated and over-long cursors and bad queries are refused.
- The three admitting permissions are allowed. Others, mixed family roles, unknown subjects, non-human selectors and cross-site requests are refused.
- A direct service call as a refused actor shows the database decides independently of the controller.
- Page two is refused after permission revocation and after school, organization or entitlement suspension.
- The runtime ACL holds, and reads have zero effects.

**Ablations the proof catches:**
- On the function: the school filter, the keyset comparison, an extra admitting permission, the confirmed-period evidence, the state filter and the id tiebreak.
- On the compiled service: the filter-bound cursor and the API-side human-context check.
