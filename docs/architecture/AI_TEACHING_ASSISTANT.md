# Claire AI Teaching Assistant — guarded draft foundation

**Status:** Development migration, restricted-role local verification, API/UI tests, and the full workspace validation have completed. This document does **not** authorize a provider request, paid-call gate, consumer activation, or production rollout.

## Bounded capability

Claire is the HON AI Team agent titled **Curriculum support guide**. `/staff/teaching-assistant` accepts exactly one **already-known published curriculum UUID** and an optional bounded teaching brief. The server resolves **exactly one current staff school**; there is no school, organization, provider, model, authority, tier, data-directory, curriculum-list, arbitrary-prompt, or delivery selector.

Only a direct `HUMAN_USER` / `HUMAN_UI` staff principal, with no delegation or Action Engine request, can use the boundary. The SQL scope resolver requires an active Complete entitlement plus `teaching.studio.read`, `teaching.assistant.use`, and `ai.invocation.plan`; it excludes HQ, parent/guardian/student/family roles and non-human principals.

## Data and provider boundary

The durable request can prepare a text invocation from **published curriculum name/description/model/version, ranks, and requirement code/kind/required/version only**, plus the safe bounded staff brief. It deliberately does **not** use Teaching Studio records: that foundation has human lesson/revision provenance but no independent AI-approved source lifecycle for this slice. It does not read or send student/family/staff identity, instructor assessments/notes, attendance, testing, promotion rationale, payment, messages, private knowledge, documents, URLs, or raw source records.

`DRAFT_TEACHING` is a closed `claire` text task, with fixed 4,096 input / 1,024 output budgets and a 100,000 USD-microunit ceiling. Provider/model/routing selection remains the existing HQ-approved invocation plan. The server-only OpenRouter adapter has no SDK, tools, fallback, or Manus dependency. It requires both an existing configured `OPENROUTER_API_KEY` and `OPENROUTER_PAID_CALL_APPROVED=true` immediately before transport. This change neither sets nor tests with that gate enabled. Isolated fakes are dependency-injected and must make zero network calls.

## Durable approval and no-effect behavior

Provider results are recorded through the existing usage/cost/credit ledger, then produce only one `CONFIRM` proposal for `teaching.draft.save`. The proposal binds the exact invocation/curriculum/version/title/content payload hash, policy, and expiry. A different qualified human must approve. Approval never executes automatically; the requestor invokes the internal typed save adapter only after approval. Save inserts a private `teaching_studio_ai_drafts` evidence record, **not** a lesson plan/resource/assessment revision and not a publication. Denial preserves incurred usage and saves nothing. Timeout, network, or ambiguous persistence is `UNKNOWN`, retains reservation where appropriate, is quarantined, and is never resent automatically.

No path creates or changes a lesson, resource, assessment, student, attendance, curriculum progress, testing candidate, promotion, schedule, payment, message, notification, external delivery, or publication.

## Storage and verification

Migration `0100_claire_teaching_assistant.sql` adds forced-RLS, deny-all private invocation/draft/workspace tables with immutable identity/payload triggers and organization/school composite ownership. Only exact reviewed `SECURITY DEFINER` functions are intended to execute for `hon_runtime`; raw brief and full draft content are returned only on the exact authorized invocation read. Canonical runtime grants and verifier sections must retain client/PUBLIC denial and direct table/column denial.

## Verification and remaining guardrails

`apps/api/test/teaching-assistant.test.cjs` uses a fake provider boundary to prove that a missing gate makes **zero** transport calls and that closed requests reject authority, provider, selector, and unsafe brief/draft input before database access. The browser test validates the guarded, no-index workbench.

`packages/database/scripts/test-teaching-assistant-integrity.mjs` requires an explicit localhost-only disposable `hon_teaching_ai_validation` connection and refuses an OpenRouter key or paid-call gate. It verifies forced RLS, private tables, no PUBLIC/direct-runtime reads, exact function-only runtime ACLs, and the restricted `hon_runtime` posture:

```bash
env -u OPENROUTER_API_KEY -u OPENROUTER_PAID_CALL_APPROVED \
  HON_TEACHING_AI_VALIDATION_TARGET='postgresql://<local-owner>:<password>@localhost:5432/hon_teaching_ai_validation' \
  pnpm db:test-teaching-assistant
```

- [x] Apply the migration in a disposable local database and verify RLS, ACLs, functions, and restricted runtime posture.
- [x] Run focused API/UI tests, migration checks, and workspace compilation after the local fixture is available.
- [x] Exercise fake-result approval, denial, stale-policy/expiry, quota, replay/concurrency, raw-source rejection, and zero-side-effect cases against the disposable database with a rejecting external-network sentinel.
- [ ] Obtain a separately documented owner authorization before any real paid provider call; do not enable the gate in code or test.
