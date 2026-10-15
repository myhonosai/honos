# Marketing Assistant — guarded local checkpoint complete

**Status:** The guarded disposable-local checkpoint after `43910ce` passed. The implementation may be committed after the recorded checks; this does **not** authorize a production/Supabase migration, deployment, paid provider call, or downstream consumer. Passing ACL or unit tests alone never establishes safe execution; the recorded real-role lock/expiry/replay integration proof is also required.

## Bounded implementation

`/staff/marketing/assistant` accepts a verified school owner’s already-known campaign UUID and a brief of at most 2,000 characters. It reuses the existing campaign workspace, durable `work_items`, HQ provider/model/routing control plane, `ai_invocation_plans`, `ai_usage_ledger`, and Action Engine approval UI. There is no external publishing, delivery, spend, audience creation, messaging, payment, membership, or student/family data adapter.

The request is actor/school-owned, fingerprinted, and durable before inference. Only a live direct human owner on active Complete with exact `marketing.campaign.read`, `marketing.assistant.use`, and `ai.invocation.plan` authority may generate or save. Existing campaign content reads use the existing human campaign-read boundary. Multi-school scope resolution remains deliberately unambiguous; client tenant/actor/model/provider/authority selectors are rejected.

The fixed Marcus `DRAFT_MARKETING` text task requests 4,096 input and 1,024 output tokens with a 100,000 USD-microunit provider ceiling. Organization-wide UTC-month actual usage plus durable reservations is bounded by 12,000 customer credits. Provider/model selection comes from a live healthy HQ-approved route, not the brief. Production uses the fixed OpenRouter HTTPS endpoint without redirects, tools, SDKs, inferred credentials, or automatic fallback. Both `OPENROUTER_API_KEY` and an explicit operator-set `OPENROUTER_PAID_CALL_APPROVED=true` are required before transport. **This task neither requested nor supplied a key and made zero OpenRouter calls.** Test fakes exist only through dependency injection.

`PENDING` may become `CONFIGURATION_REQUIRED`, `BLOCKED`, or `SENDING`. A verified successful generation atomically records actual usage, immutable title/content, and the existing `marketing.draft.save` CONFIRM proposal. A different currently qualified human must approve its exact payload hash, campaign/version, policy version, and expiry. An internal-only save attaches that exact content to `marketing_campaign_content`; it is never publication. Rejection preserves incurred usage without saving content. Timeout/network/ambiguous persistence outcomes are `UNKNOWN`, retain the reservation, and cannot be resent. Stale in-flight requests are quarantined; safe pre-send states have an explicit retry command.

Briefs and drafts are plain bounded text. Syntax checks reject common credential patterns but are **not semantic PII classification**; owners must not enter confidential student/family/payment records. No external information lookup or school-record harvesting occurs.

## Database security and verification

Migrations `0089`–`0091` introduce three private forced-deny-all-RLS tables: `marketing_ai_invocations`, `marketing_ai_drafts`, and `marketing_campaign_content`. Runtime and client roles have no table or column access. Only fixed reviewed functions execute; helper/trigger functions do not. Immutable triggers preserve request identity, generated content, and campaign attachments.

Canonical `infra/postgres/010_supabase_hon_runtime.sql` reconciles table, column, client, helper, and function privileges. Canonical `011_verify_supabase_hon_runtime.sql` contains the single Marketing Assistant assertion block, reused by `marketing-assistant-security.mjs` and the full `db:verify-rls` registry. It checks forced RLS, absence of policies/nonowner ACLs, trusted nonruntime ownership, exact function EXECUTE/definer/volatility/search paths, no grant options, immutable trigger shape, and the sensitive non-staff-assignable permission.

The fixture reset accepts **only** `localhost:5432/hon_marketing_ai_validation`, owner `hon_marketing_ai_owner`, and restricted `hon_marketing_ai_runtime`. It refuses pre-existing unmarked databases/roles. Generated database credentials are written only into a private job-directory file, never logs or version control. It recreates the disposable fixture, applies all 91 migrations, and applies canonical 010 twice. No configured Supabase/production credentials or remote fixtures are used.

```bash
# Run from the repository root. The directory must be a private task job directory.
HON_MARKETING_AI_VALIDATION_TARGET=postgresql://localhost:5432/hon_marketing_ai_validation \
HON_MARKETING_AI_ENV_FILE=/home/ubuntu/jobs/<job-id>/local.env \
pnpm db:setup-marketing-assistant

# Never print this file or use xtrace. It contains only disposable-local DB credentials.
set +x
. /home/ubuntu/jobs/<job-id>/local.env
unset OPENROUTER_API_KEY OPENROUTER_PAID_CALL_APPROVED
pnpm db:test-marketing-assistant-verifier
pnpm db:verify-rls
pnpm db:test-marketing-assistant
```

With both database URLs and paid-provider variables unset, run the root `check`, `test`, `db:check`, and `build` commands. API provider tests use injected transport; the HTTP guard tests bind only loopback; UI tests mock fetch. The database integrity test installs a rejecting global fetch sentinel and asserts zero external calls.

## Resolved review/save acceptance proof

`save_approved_marketing_draft` now retains the review boundary's complete live qualification: active, unambiguous direct human reviewer; no HQ or effective PARENT grant; and current exact `action.approve`. It locks reviewer identity, grants, roles, permissions, policy, draft, and work item before final authority, current-target, and approval-expiry checks. The restricted-role test holds natural grant or work-item row locks, proves that the specific restricted runtime save is blocked by that admin backend, then commits revocation or lets the relevant clock expire. Each save is denied with 403 and produces no content/effect.

PostgreSQL deliberately protects another role's `pg_stat_activity.query`, so query-text matching was not a sound readiness signal. The fixture gives only its test runtime pool a random `application_name` and uses `pg_blocking_pids(pid)` to witness that exact connection waiting on the known admin lock-holder PID. This is test-only observability; it neither adds SQL runtime privileges nor changes production locking. The wait remains a real database dependency wait, not a timing delay or a mock.

Exact DENIED command replay reads the resolved durable receipt only after live reviewer authorization and exact binding validation, returning the prior receipt without another decision, audit, content save, or state effect. All assertions run as final real-role integration assertions; none is skipped or converted to an expected failure.

## Rollout limitations

Fresh local validation passed: the guarded 91-migration reset/canonical 010 setup; 12-group restricted-role Marketing Assistant integration with a rejecting global-fetch sentinel and zero provider calls; ten rollback-only drift probes; full `db:verify-rls` coverage of 127 tables; and canonical 011. Root `pnpm check`, `pnpm test` (447 tests: API 135, web 123, auth 91, domain 98), `pnpm db:check` (91 migration files), `pnpm build`, and `git diff --check` also passed with database and paid-provider variables unset. Focused Marketing Assistant API tests pass 7/7 and UI tests pass 5/5. The build retains only existing non-blocking CSS Autoprefixer warnings.

No deployment, remote migration, paid-call permission, key request, provider request, or downstream consumer activation has been performed. This checkpoint permits only the local source commit/push; real provider reconciliation, external marketing publication/delivery, production migration, and additional AI tasks remain separately reviewed work.
