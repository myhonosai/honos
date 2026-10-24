# D10 — exception-only policy decisions and enforcement

Baseline: `b54ea12565b38e44ae0227c1acc8cd3090302a13`. New additive migration **0186**; 0179/0180 remain reserved. No approval decision is seeded. This is a source implementation for review, not operational approval or deployment.

## Architecture audit and choice

0185 already validates live direct-human HQ-owner authority, exact school/organization, entitlement version, duration, justification and canonical lock order. It grants while immutable `saas_access_policy_terms` v1 is PROPOSED. The latest `PAID_ACCESS` policy record is PROPOSED; its older decision projection is UNDECIDED. Those records also cover proposed payment/lifecycle behavior and cannot safely be relabelled APPROVED for exception administration alone.

Reuse canonical SaaS identity, request claims, audit/inert outbox, forced RLS and version checking. Add one private, append-only **exception-only decision ledger**. Do not create another entitlement authority or modify payment/credit programs. The existing grant request shape remains unchanged. Its response gains a nullable governing-policy binding, allowing historical pre-D10 exceptions to remain explicitly unverified rather than being backfilled as approved.

## Decision semantics

- Explicit owner actions append PROPOSED, APPROVED, WITHDRAWN or REVOKED decisions with monotonically increasing revision and an expected prior revision. No record is updated or deleted. Every prior revision is superseded for **new grants**, while remaining immutable historical evidence.
- Proposing/approving requires the exact existing terms version, explicit maximum days, finite validity dates and justification. Approval additionally requires the exact exception-only confirmation phrase and same-origin human-command marker. The 90-day existing technical ceiling is not an approved value or a default approval.
- Latest decision wins. PROPOSED deliberately disarms new grants, as do absence, future start, expiry, withdrawal, revocation or a terms-version mismatch. There is no automatic fallback to an older approval.
- Approval authorizes creation of exceptions within its window; it does not itself grant access. Existing exceptions retain their own captured expiry/terms if policy is later changed or expires. They may be explicitly revoked or cleaned up as before. No silent extension or bulk access change occurs.
- A new grant/renewal binds to the exact current approval, policy revision, underlying terms version and maximum. A pre-D10 record retains a null binding, is never retroactively approved, and remains revocable/cleanable. Replaying an already committed identical command is historical evidence, not a new grant or extension; current actor authority is still required.

## Enforcement and transactions

Grant command and INSERT backstop both require an approved, current, time-valid decision and enforce its maximum. No browser role, GUC or request field supplies authority. Runtime has no direct table privileges. Deferred evidence checks require a completed matching request, audit, inert outbox and exact receipt before commit; direct writes cannot silently create an approval or unrecorded exception.

Lock order is existing IAM SHARE locks → idempotency request → organization/entitlement (grants only) → global policy advisory lock. Policy decision commands **never lock or mutate organizations or entitlements** after acquiring the policy lock. All participating paths therefore preserve the same partial order. Grants hold the policy lock through commit; policy changes serialize before or after them. Revalidate time and authority after waits and at deferred commit checks. Deferred trigger functions are private SECURITY DEFINER functions so their checks execute with the same trusted owner at runtime COMMIT. Commands refuse REPEATABLE READ/SERIALIZABLE transactions: a retained snapshot must never hide a newer append-only policy head after a lock wait; the canonical runtime mutation path already uses READ COMMITTED. Withdrawal does not lock exception organizations or retroactively revoke them.

## API contract

`GET /v1/hq/saas/access-exception-policy` and `POST /v1/hq/saas/access-exception-policy` (human-command marker `saas-access-exception-policy-decision`) use existing identity, human-read/command guards, closed contracts, UUID idempotency and SaaS error mapping. Owners alone decide; independently authorized billing operators may read. School, family, support, delegated/AI and expired/revoked authority are denied independently by database functions.

The existing exception grant input, revocation, cleanup and purchase APIs remain unchanged. New receipt metadata is a server fact, not a client selector. No policy-approval frontend or customer checkout is enabled here.

## Verification and non-effects

Add disposable proof cases for absent/PROPOSED/invalid policies, explicit synthetic approval, enforced limits, immutable history/bindings, direct writes, expected-revision/idempotency races, policy/grant arrival orders, owner revocation/clock expiry while waiting and full rollback. Reuse D9 revoke/cleanup/450-row/Champions/revoke-first regressions with clearly labelled synthetic fixture decisions. Full paid-access terms stay PROPOSED in every test.

Extend the staging manifest through 0186 without changing 0181–0185 hashes; keep network/AI tripwires, shipped-empty decision assertions and before/after posture/cleanup checks. No real policy is approved. Synthetic decision records exist only in fresh marked disposable databases and are removed by fixture cleanup.

Remaining gates: independent code/security review, explicit owner approval of actual exception parameters and decision recording, persistent-database baseline/backups/rehearsal/deployment authorization. Full paid-access/B6B, Stripe, checkout, AI economics and real-school use remain separate gates. Paid access and AI credits remain INACTIVE as shipped.
