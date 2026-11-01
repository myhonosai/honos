# A2P-1: website readiness and registration draft backend

Baseline: `5e110057612b4846a73e4be7a45ead5212c1ffc2`.
This is preparation assistance, not legal advice, carrier approval, consent
collection, provider configuration, registration submission or SMS delivery.
PRs #78, #79 and #80 and Claude's frontend are not modified or imported.

## Implementation boundary

A2P-1 is a **stateless, read-only preparation engine**. No assessment/draft history,
customer consent, approval, audit mutation, idempotency claim or outbox job is
created. Each call independently resolves the exact school and a live authorized
human; entitlement/permission loss is checked again before returning results.
Responses and computation digests use the final reauthorized scope, including
the latest owner-confirmation capability. Losing OWNER while retaining the
preparation permission allows unconfirmed preparation with that capability
false; owner-confirmed drafts, validation and copy remain forbidden.
Outputs identify their scope, engine/source version, owner-confirmed versus
synthetic evidence and missing facts. Digests detect changed draft inputs; they
are not signatures, authority or durable acceptance evidence.

Migration 0190 adds only `communication.a2p.prepare` and a fixed school-scope read
boundary. Existing system OWNER roles receive this conventional permission;
other staff require explicit assignment through the existing permission system.
Only a current school OWNER can confirm facts for copy-ready drafts; delegated
preparation staff can review/check missing inputs but cannot impersonate owner
confirmation. The server returns this capability from live role grants.
The function enforces active school/organization, an active in-window entitlement,
eligible direct-human staff, exact live role grant, and rejects HQ, family,
delegated, AI and cross-school contexts. All legacy migrations and RLS are
preserved. There are no new data tables or grants to private records.

Read-only work does not need persistent command idempotency: identical normalized
inputs and scope produce the same digest and draft. No external or database write
can be duplicated. Requests have server request IDs, but no claim of a stored
receipt. Persistence, amendment/version history and durable approval/audit require
a separately reviewed later slice; the frontend must not pretend these exist.

## Safe inspection and evidence

The production inspector is unconditionally disabled. There is no env switch,
fetch implementation, DNS resolution, browser rendering, crawl, authenticated
request, cookie, credential, redirect-following or external provider request.
Real public URL reviews return **UNAVAILABLE**, not PASS or missing-policy claims.
Clients cannot submit HTML, observations, fixture selectors or fake evidence.

The engine consumes structured observations from a trusted inspector boundary.
Local website fixtures exercise complete/missing/contradictory/dynamic pages,
consent controls and redirects. Every fixture finding is explicitly synthetic;
even a fixture PASS is not a real website or compliance approval. This slice does
not implement an HTML semantic parser or prove checkbox behavior from keywords.
Dynamic behavior, CSS/JavaScript visibility and unsupported observations stay
REVIEW_REQUIRED; absent/unreachable evidence stays UNAVAILABLE.

Prospective inspection policy helpers validate public HTTPS selectors, reject
credentials/query/fragment/ports/IP literals/local names, require every resolved
address to be public, reject mixed/private/unsupported address families, bind
connection IPs to approved DNS answers, restrict redirects to the approved origin,
and cap pages/bytes/time/redirects. IPv6 inspection is unavailable in this first
policy contract rather than incompletely implementing IPv6 classification.
These pure helpers do not establish a safe live fetcher. A future adapter needs
independent SSRF/DNS-rebinding review, address pinning, TLS/SNI validation, egress
controls, response streaming limits, robots/privacy policy and explicit owner
authorization. Do not introduce an unrestricted crawler or run arbitrary URLs.

## Rule outcomes and source records

Each finding has a stable code, PASS / NEEDS_FIX / REVIEW_REQUIRED / UNAVAILABLE,
reason, remediation, source references and exact observation references. A
passing individual observation never means overall legal compliance or carrier
acceptance. Conflicting identity/sharing/consent claims need correction or human
review. Marketing and transactional consent are independently evaluated; privacy
acceptance is not SMS consent. Optional unchecked SMS consent is distinct from
general terms acceptance and must not be made a condition of purchasing services.

Sources reviewed **2026-10-25**, retained with the ruleset:

- [Required business/campaign information](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/collect-business-info)
- [Campaign onboarding guidance](https://help.twilio.com/hc/en-us/articles/11847054539547-A2P-10DLC-Campaign-Approval-Best-Practices)
- [30932: mobile opt-in sharing disclosure](https://www.twilio.com/docs/api/errors/30932)
- [30923: voluntary messaging consent](https://www.twilio.com/docs/api/errors/30923)
- [Privacy/terms URL requirement effective June 30, 2026](https://www.twilio.com/en-us/changelog/a2p-10dlc-campaign-registration-will-require-privacy-policy-and-)

The business-information, error-code and changelog pages were directly readable.
The Help Center page required client rendering; its official indexed excerpts
were reviewed, not a claimed full rendered-page inspection. Recheck the complete
current Help Center guidance before enabling a provider adapter.

Use the current provider rules when actually registering. The engine records the
review date; it does not represent guidance as permanently current or guaranteed
approval. Actual privacy/terms documents and SMS opt-out/help configuration must
be reviewed by the business and appropriate qualified advisers.

## Draft facts, templates and owner confirmation

Facts are explicit nullable fields: business name, website/privacy/terms/opt-in
URLs, support contact, actual message flow and frequency. Missing values are
reported; no business details, consent evidence, enrollment or payment facts are
invented. School display identity comes from the authorized database read;
different trade/legal names remain a review item rather than a fabricated match.

The generator supports trial confirmation/reminder, requested enrollment
follow-up, class changes, closure, tuition notification and promotional templates.
Customer names/dates/amounts use clearly marked variables, never fictional
operational records. One selected template supplies two distinct variants;
multiple selections supply 2–5 representative samples. Marketing/MIXED claims
require explicit separate marketing-consent confirmation. Unsupported use-case
or template combinations are rejected. Copy describes only the owner's actual
provided flow, not an invented welcome, double opt-in, recording or delivery step.

Generated HELP/STOP replies are **proposed samples**, not configuration or proof
of working opt-out handling. Pricing/discounts are not invented in promotion
samples. Tuition copy does not create a debt or claim collection. All outputs
retain external review requirements; confirmed facts are not customer consent or
recorded approval. Copy/export recomputes the draft and checks its expected digest
and explicit review acknowledgement; it prepares plain text only, with no file
upload, email, public URL, provider submission or delivery.

## Frontend handoff and AI

See `docs/CODEX_A2P_1_BACKEND_HANDOFF.md` and
`packages/contracts/src/a2p-registration.ts` for closed payloads and routes.
The frontend must keep inputs/results in the authorized school context, discard
old-scope responses, preserve privacy shielding, handle access loss, render plain
text and never show an assessment/draft as saved, compliant, registered or sent.

HON can explain stable finding codes, show source-backed remediation and prepare
the deterministic templates. Future AI access must use existing provider routing,
usage planning and typed governed tools; page text is untrusted data, never tool
instructions. No AI provider, premium credit reservation, model call, autonomous
correction, website editing or external message is enabled here. Human decisions
and external submission remain separate from suggested content.

## Verification and next gates

Test closed contracts, all rule states, missing facts, contradictions, template
claims, safety/redirect/DNS policy, deterministic digests, exact-school denial,
revocation, direct-human transport and zero mutations. Use local synthetic
website fixtures and disposable PostgreSQL; distinguish these from a real public
site inspection and live Twilio testing. Run full repository checks, migration
validation, runtime security reconciliation and canonical disposable proofs.

Next gates: independent security review; frontend integration against merged
contracts; optional assessment persistence/retention/auditing; reviewed live
inspection adapter; provider-specific campaign category/brand eligibility and
manual owner review. No Twilio/Zernio key, registration, SMS, activation, policy
approval, deployment or automatic merge is authorized by this PR.
