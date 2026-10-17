# HQ Organization Entitlement Transition

## Purpose

This boundary adds one **non-commercial, immediate, HQ-controlled** transition for an existing organization entitlement:

- `CORE → COMPLETE`
- `COMPLETE → CORE`

It exists to make the current Core/Complete server enforcement boundary administrable without pretending that public pricing is a subscription, payment, provider, or credit allocation system.

## Explicit non-goals

This transition does **not**:

- create an offer, checkout, subscription, invoice, payment, refund, tax, commercial renewal, or provider relationship;
- grant, debit, reset, reconcile, or promise AI credits;
- activate OpenRouter, Meta, Google, Stripe, Square, messaging, an outbox consumer, a worker, Action Engine execution, or external delivery;
- create a school/staff/family/parent identity or grant access;
- schedule a future entitlement, retain a commercial pricing history, or infer a grandfathering rule;
- convert **Essential**. Existing Essential records are deliberately untouched.

> Public Core/Complete $149/$249 prices and 5,000/12,000 AI values remain display/planning metadata. See [the audit](CORE_COMPLETE_ENTITLEMENT_ENFORCEMENT_AUDIT_2026-10-17.md).

## Authority and scope

`hon.transition_organization_entitlement_from_hq(...)` is a fixed `SECURITY DEFINER` function with controlled `search_path` and a closed signature. It resolves the actor from the authenticated external subject and requires exactly one current active direct `HUMAN_USER` identity with either:

- `HON_HQ_OWNER`; or
- `HON_HQ_OPERATOR` with the exact `hq.entitlement.manage` permission.

It rejects missing/ambiguous identities, inactive/expired/future/revoked HQ grants, family identity, tenant/school/principal/source/action/delegation GUC context, and any unrecognized target. School, parent, family, AI, delegated, and Action Engine contexts cannot borrow HQ authority.

The caller supplies an untrusted organization UUID, an expected positive version, target tier, idempotency key, request ID, and correlation ID. The server validates all of them and locks/rechecks the live HQ grant and current entitlement before mutation.

## Allowed state transition

The current `organization_entitlements` schema is one row per organization, so this boundary is **immediate only**. It permits only a live active current `CORE` or `COMPLETE` row to change to the other tier. It rejects:

- every Essential source and target;
- no-op targets;
- missing, inactive, future, or expired rows;
- stale expected versions;
- invalid target strings and unsafe versions.

The row receives a monotonic `version`, current `effective_from`, and `updated_at`. Existing school APIs continue to read their active tier only through `hon.read_current_organization_entitlement()`; no UI or caller claims a tier directly.

## Atomic evidence and replay

The migration adds private forced-RLS request, audit, and inert outbox records. In one transaction, the fixed function writes:

1. the current entitlement tier/version change;
2. a redacted prior/next fact pair;
3. immutable HQ audit evidence;
4. one internal-only, `executionAllowed: false` outbox fact; and
5. an idempotency receipt.

Idempotency is scoped to the HQ actor plus UUID key. A completed matching fingerprint replays the same redacted receipt with `replayed: true`; a mismatched fingerprint or in-progress key fails closed. Evidence tables are immutable and unavailable to the runtime role except through the fixed transition function.

## API boundary

`PATCH /v1/hq/organizations/:organizationId/entitlement` is a direct-human HQ administrative endpoint. It requires the existing verified identity guard plus strict same-origin JSON/fetch-metadata command posture. Its closed request body carries only:

```json
{
  "targetTier": "CORE | COMPLETE",
  "expectedVersion": 1
}
```

`Idempotency-Key: <UUID>` is a required request header. It is deliberately not accepted in the JSON body.

The returned receipt contains only organization ID, prior/target tier, resulting version, effective timestamp, and replay state. It never includes a price, credits, payment, provider, school/family/user, entitlement source table, or external-execution fact.

## Validation boundary

The guarded disposable-local test creates a fresh marked PostgreSQL fixture only at `localhost:55432/hon_entitlement_validation`. It verifies both directions, all Essential source/target rejections, exact owner/operator/mixed-context denials, stale/no-op/replay/key binding, lock-time grant expiry/revocation, rollback/evidence failure atomicity, private ACL/RLS/immutability/escalation denial, canonical verifier drift rejection, and the fixed school entitlement reader.

The test must never be pointed at a remote/Supabase/shared database. It is not production proof and does not authorize any commercial/provider/payment/deployment operation.
