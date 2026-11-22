# Maya renewal prep (P5, migration 0646)

Status: spec + build, 2026-11-22. Asked for by David ("I want all ai agent backend done and switch them on"). It replaces Maya's
"Renewal preparation: Backend required" line in the Ask HON roster (`apps/web/src/components/hon-command/roster.ts`). Built the
same way as Jordan follow-through (`JORDAN_FOLLOW_THROUGH.md`, 0640) and reuses the 0639 line, key and immutability helpers.
"Send, schedule or track outreach" stays Backend required: that is P8 (send approved drafts after button or voice approval).

## What it does

A staff member asks Maya to look over memberships whose term ends in the **next 30 days** or the **next 60 days**, with an optional
note ("summer break starts in three weeks"). Maya reads up to 30 ACTIVE or CANCELLATION_PENDING memberships ending in that window,
soonest first, and answers with a short summary and up to 10 suggestions, at most one per membership: a priority (HIGH, NORMAL,
LOW), a talking point for the renewal conversation, and why.

Nothing happens until the person ticks suggestions and presses **Open reviews**. Each ticked suggestion becomes an OPEN renewal
review through the ordinary human renewal path (0080 `hon.mutate_renewal` CREATE) as that person:

- review window: now to the membership's term end;
- note: Maya's talking point, then "Why: " and her reason;
- reason: "Prepared with Maya (High/Normal/Low priority)";
- reminder needed: on.

The usual renewal audit and `billing.renewal.human_revised` outbox event are written by 0080 itself. The whole apply is refused,
with nothing partial, when a membership changed after Maya read it (version), has ended or left ACTIVE/CANCELLATION_PENDING, or
already has an OPEN or DEFERRED renewal review. An exact retry replays. Maya never contacts a family, and never changes a
membership, schedule, price or payment.

## Contract

- Kind (0550): `MAYA_RENEWAL_PREP`, agent `maya`, task class `ANALYZE`, budgets 12,000 in / 3,000 out, max provider cost 80,000
  micro-USD, result at most 12 KB, caller `HUMAN_UI`, subject `SCHOOL`, usage agent `RETENTION`. No S4 function changes.
- Who asks: a direct human at the session school who passes Maya's 0259 reader rules (`retention.review.read`, no HQ or family
  role, active Complete entitlement) and also holds `billing.membership.read`, `billing.renewal.manage` (0080 rules) and
  `ai.invocation.plan`. The planner enforces the per-staff Maya switch (`ai.agent.maya.use`, 0635) on every call.
- Who reads: Maya's 0259 rules plus `billing.membership.read`, and **only the requester's own lists** (the view shows member names
  and term-end dates).
- What Maya is sent: brief, school name, local date, and per membership only the alias (M1..M30), state, days until the term ends,
  months as a member, classes attended in the last 30 days and the 30 before, days since the last class, and whether a renewal
  review is already open. No name, contact, family, plan code, amount or payment record.
- Answer shape: `{summary ≤300, suggestions[1..10] {membership M1..M30, priority HIGH|NORMAL|LOW, talkingPoint ≤300, reason ≤300}}`,
  one per membership, each line trimmed, no control characters (`hon.maya_renewal_ok` and `validateMayaRenewalProposal`). An answer
  outside the shape or naming an alias Maya was not given is stored empty and rejected; one with a link or email address is
  rejected by the API. Both keep their usage.
- Evidence: `hon.maya_renewal_refs` (alias to membership at the version read, fixed at prepare) and `hon.maya_renewal_applied`
  (suggestion to renewal review), both append-only, forced RLS, no runtime access.
- API: `GET|POST organizations/:o/schools/:s/maya/renewal-prep`, `POST …/:id/apply`, `POST …/:id/close`; human commands
  `maya.renewal_prep.read|request|apply|close`; scope resolved with `retention.review.read`.

## Proof

`packages/database/scripts/test-maya-renewal-prep.mjs` (MRP1, 9 groups) on a fresh disposable AI-0 fixture with a counted fake
provider and refused network: custody, what is and is not sent, apply through 0080 with replay, refusals (open review, changed
membership), rejected answers, unknown outcome and RETENTION usage, gates and isolation, append-only evidence, and the 0646 exact
011 section.
