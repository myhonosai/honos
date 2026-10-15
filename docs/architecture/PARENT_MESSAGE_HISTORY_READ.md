# Parent/Eian Message History Read

## Delivered boundary

`GET /v1/parent/messages` and authenticated dynamic `/parent/messages` implement a **read-only, selector-free Parent/Eian observation boundary**.

- The caller provides no school, family, child, recipient, message, channel, date, staff, sender, delivery, or action selector.
- The server resolves the verified subject through the canonical `hon.resolve_parent_journey_scopes(subject)` function. Exactly one live scope is required; `PRIMARY_GUARDIAN` and `SECONDARY_GUARDIAN` are allowed. `VIEWER`, missing/revoked access, ambiguity, staff, and HQ have no fallback path.
- The API service checks the canonical scope before and after the fixed SQL projection. The SQL function independently resolves and rechecks the same scope.
- The runtime wrapper uses a `REPEATABLE READ READ ONLY` transaction with timeouts. The new reader has one fixed `SECURITY DEFINER` function entry point and no parent-route table query.
- RLS remains enabled and forced on `hon.communication_messages`; the migration adds only `EXECUTE` on the fixed parent reader and no new direct source-table grant.

## What it returns now

The message queue foundation has only `DRAFT`, `QUEUED`, and `CANCELLED` lifecycle states and explicitly has no provider delivery or receipt integration. Queueing proves only an internal intent and consent check at queue time; it does **not** prove that a guardian or child received a message.

Accordingly the contract is deliberately fail-closed:

```json
{
  "generatedAt": "...",
  "accessLevel": "PRIMARY_GUARDIAN",
  "messages": {
    "status": "UNAVAILABLE",
    "reason": "RECEIPT_EVIDENCE_UNAVAILABLE",
    "items": [],
    "limited": false
  }
}
```

No queue content is returned. This is preferable to labelling a draft, queued, cancelled, scheduled, or provider-accepted message as **received**.

## Explicit exclusions

The reader never returns or infers another family, staff/HQ, lead, campaign, marketing, broadcast, recipient-list, sender, identity, raw phone/email, consent/opt-out, delivery/provider, queue lifecycle, message ID, family/child/school ID, internal-note, or non-addressed content detail. It has no sending, reply, consent change, opt-out, recipient creation, queue mutation, provider delivery, AI, Action Engine, voice, automation, payment, audit/outbox, or external-call path.

The API is private/no-store/no-referrer/no-index. The client verifies the full allowlisted response shape, uses same-origin credentialed `GET` with `cache: 'no-store'`, and clears all state on blur, hidden, pagehide, focus/visibility revalidation, access loss, or response-verification failure.

## Future prerequisite

Do not expose message content from this reader until a separately reviewed conventional delivery/receipt model records a **provable received fact**, supports a fixed current-family/current-active-child link, preserves forced RLS and function-only projection access, and has redaction/retention/consent/privacy reviews and negative security proof. Provider acceptance alone remains insufficient.
