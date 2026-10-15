# Deterministic automation rule configuration foundation

## Hard boundary

[Staff automation rules](/staff/automation/rules) is **configuration only; no execution** in Essential, Core and Complete. Creation, enabling and revision never subscribe to an event, schedule a job, call a domain service or create work. Explicit dry-run returns an inert manual review template **description**, not a work item, action request, command, approval or external effect.

No scheduler, worker, event consumer, provider/AI/LLM/model call, Action Engine execution, communication, payment, public publishing or delivery adapter is added. Do not attach an outbox consumer or executor without a separately reviewed capability and approval boundary. Enabled means eligible for manual synthetic evaluation only.

## Inspection and deliberately closed catalog

- Durable `work_items` already have scoped human `work_item.create` / `read` / `manage` boundaries and finite states. This feature neither calls them nor emits their create contract. Its inert description names the separate future human permission and policy checks; it contains no assignee, work-item state or executable command body.
- Action Engine and its `ACTION_CATALOG` are execution infrastructure. **No automation rule permission/proposal is added to that catalog or tool dispatch.** Approval posture cannot be weakened to AUTO/CONFIRM or used as an Action Engine approval.
- CRM's implemented `crm.lead.created`, schema version 1, is stable across conventional lead creation and governed public forms/imports. The descriptor `LEAD_CREATED` accepts synthetic source metadata only from HUMAN_UI or PUBLIC_API; ANY means only these two allowlisted sources, never every platform principal/source. There is no subscription or raw event ingestion.
- CRM's implemented `crm.trial.outcome.recorded`, schema version 1, has `appointmentType`, `status`, and aggregate version. `TRIAL_NO_SHOW` describes the TRIAL / NO_SHOW subset. The human-only outcome boundary supports HUMAN_UI. Outcome notes, contacts and real IDs are not accepted by dry-run.
- Billing has invoice/membership foundations and payment-attempt reporting, **not a reviewed stable payment-failed ingestion contract** for this slice. Scheduling and communications have live consequential services/events and are not appropriate inert rule descriptors without further schema/policy work. Payment failed, automatic follow-up/send, booking, billing, publishing and arbitrary domain actions are absent.
- The actual tier registry has `automation.advanced` only for Core/Complete. No advanced capability is implemented or inferred from this flag. The sole conventional inert proposal is useful in all three tiers with exact permissions. No tier adds AI authority.

## Exact staff authority

| Permission | Allowed operation |
|---|---|
| `automation.rule.read` | Bounded school list, exact current rule, immutable version read |
| `automation.rule.manage` | Create rule identity and append configuration versions; save response only |
| `automation.rule.dry_run` | Evaluate exact current saved version using synthetic metadata; JSON return only |

These permissions are independent: read is not manage or dry-run, and manage is not read/dry-run. UI capability booleans are display hints, never authorization tokens. Rule identities are school configuration, not a staff directory. Parent/family grants, HQ grants, public ingress and AI/automation/integration principals do not establish authority. A human who separately holds a legitimate school staff grant is authorized only through that exact staff role, not a parent context.

The existing internal `staff_member_eligible` predicate requires an existing active unique HUMAN_USER principal, an ACTIVE organization/school, current non-revoked school staff role grant, at least one reviewed staff-assignable permission and matching role-management school. Parent/HQ/platform/system role categories and any HQ-granted principal are excluded. `automation_has_permission` separately checks that the exact permission itself comes from a current eligible staff role at that school; it cannot be borrowed from a wrong-school or parent role.

`resolve_automation_rule_scope(subject,permission)` uses the verified subject and fails closed unless the exact permission resolves one unambiguous principal/org/school. There is no client-selected scope/actor/source. Multi-school ambiguity needs a separately reviewed switcher. Human POST requires the exact configured origin, JSON, `X-HON-Human-Command: automation-rules`, and same-origin fetch metadata when supplied. Existing identity guard verifies the session. Parent/HQ/public endpoints are absent. Delegation and Action Engine IDs are rejected in API and SQL.

## Closed schemas and lifecycle

Each full-state revision requires all fields, no extra keys, and independent API/service/SQL validation:

- `expectedVersion`: integer 0–999999998 for saves; create is exactly 0, revisions match latest.
- `name`: trimmed plain display label, 1–100 characters, no controls/hidden-direction characters. Rendered escaped; never interpreted as a template or code.
- `enabled`: boolean. New UI draft defaults disabled. A human may explicitly enable/disable; both append immutable history. No hard delete or execution endpoint.
- `triggerKind`: LEAD_CREATED or TRIAL_NO_SHOW.
- `conditions`: exactly source ANY/HUMAN_UI/PUBLIC_API and minimumAggregateVersion 1–999999999. Trial rejects PUBLIC_API. No expressions, operators, arbitrary fields, SQL, JavaScript, dynamic tools or templating.
- `proposal`: exactly kind MANUAL_REVIEW_TEMPLATE, trigger-matching category LEAD_TRIAGE or TRIAL_ATTENDANCE_REVIEW, and priority NORMAL/HIGH. No recipient, content, action code, credentials, endpoint URL, provider or dynamic tools.
- `posture`: exactly `{ authority: NONE, approval: HUMAN_REVIEW_REQUIRED }`. No AI authority or approval bypass.
- `schedule`: exactly mode MANUAL_ONLY, real school-local effectiveFrom date in 2000–2099, optional exclusive endsOn date with a 1–3660 day span, and cooldownMinutes integer 0–10080. This is **human-defined simulation metadata**, not cron, timezone expansion or a delivery schedule.

At most 100 immutable rule identities per school. Lists contain only latest versions, bounded by the identity limit. Corrections/disablement append full-state versions; old versions remain readable only with current read authority. Disabled rules produce NOT_PLANNED / DISABLED even if every other condition matches. Existing schedule/cooldown metadata never mutates state as time passes.

## Deterministic dry-run and policy plan

`POST /api/v1/staff/automation/rules/:id/dry-run` requires exact current `automation.rule.dry_run`, an exact current `expectedVersion`, and these closed synthetic fields:

- Event: synthetic **true**, allowlisted triggerKind, schemaVersion exactly 1, bounded positive aggregateVersion, allowlisted source. Real event IDs, raw payloads, entity IDs, PII and domain selectors are forbidden.
- Simulation: real localDate and minutesSincePriorPlan null (no hypothetical prior plan) or integer 0–5256000. Both are caller-supplied simulation metadata, not queried event/execution history.

The evaluator checks disabled, trigger match, bounded conditions, inclusive/exclusive local date window, then simulated cooldown in fixed order. There is no current clock, random value or external data in the plan algorithm. Current time is used **only for live authorization**, not deterministic evaluation. A private SQL pure planner and a TypeScript pure reference planner share the tested contract. Identical saved version/input produce identical JSON. Current-version mismatch returns conflict rather than evaluating stale history.

Output always has configurationOnly true, executionAllowed false, ruleId/version, PLANNED or NOT_PLANNED, fixed reason, and plan/null. A matching plan contains only MANUAL_REVIEW_TEMPLATE_DESCRIPTION, category/priority, authority NONE, human review requirement, separate `work_item.create` permission, CURRENT_SCHOOL_PERMISSION / SEPARATE_HUMAN_COMMAND / CURRENT_DOMAIN_POLICY requirements and scheduleMetadataOnly true. It grants no permission or approval; there is no execution/creation link. Any future human operation must reauthorize through its own domain boundary.

Dry-run reads saved configuration, locks authorization rows for live revalidation, and returns JSON only. Locks are not record writes. It does **not** create/update work, action, receipt, audit, outbox, metrics, evaluation history, last-run timestamp or cooldown state. Reads likewise do not create configurations. Unauthorized/invalid requests never persist a rule or plan.

## Storage, locks, replay and least privilege

Migration 0078 adds immutable `automation_rules` identities, append-only `automation_rule_versions`, and immutable `automation_rule_requests` receipts. Composite foreign keys retain exact org/school ownership; insert guards validate session actor/source/request/scope, strict descriptor and consecutive version. UPDATE/DELETE/TRUNCATE are blocked. Reads expose no identity/contact directory metadata.

Fixed functions serialize organization then school, lock ordered actor user/principal/grants/roles/permissions and entitlement, and recheck current permission with the **live clock after waiting**. Reads, saves, dry-runs and replay all revalidate. Old receipts cannot bypass revoked/expired principals, grants, exact permissions, role-management scope or entitlement. Durable school/actor/key SHA-256 fingerprints retain exact saved responses; uncertain unchanged retries replay without a new version/evidence. Changed input/key reuse fails. Concurrent same-key saves produce one version plus one replay; competing expected-version writes produce one winner.

Each successful configuration revision atomically appends one redacted audit, one `automation.rule.configuration_revised` schema-v1 **inert internal outbox** record, and its durable receipt. Evidence contains only ruleId/version/enabled and configurationOnly/internalOnly/executionAllowed false; labels, conditions, proposal, schedule, contact and subject are absent. Atomic failure at audit, outbox or receipt rolls back identity/version/evidence/receipt. Dry-runs produce no such evidence.

All three tables are ENABLE/FORCE RLS with **no policies**, trusted-owner-only table/column ACLs. Non-superuser/non-bypass runtime gets only four exact SECURITY DEFINER / fixed `search_path=pg_catalog, hon` functions:

1. `resolve_automation_rule_scope(text,text)`
2. `read_automation_rules(text,uuid,integer)`
3. `save_automation_rule(text,uuid,jsonb,text,uuid,uuid)`
4. `dry_run_automation_rule(text,uuid,jsonb)`

Private validators, guards, auth/lock helpers, summary and pure planner have no runtime/PUBLIC/Supabase-client execution grants. Canonical runtime `infra/postgres/010_supabase_hon_runtime.sql`, canonical verifier 011 and JS verifier share the exact allowlist and verify owner/definer/volatility/path/ACL/grant option, RLS/policy posture, directory denial and invariant triggers. New OWNER roles already receive all current permissions via existing provisioning; migration advances existing system OWNER roles only, no role grants or HQ expansion.

## UI and operation

The same-origin `/staff/automation/rules` surface starts empty with explicit load, verified school and independent capability flags. Human editors expose only fixed fields. Current saved version, enable/disable, simulation inputs and read-only history are distinct from unsaved edits. History never changes the current expected version. Dry-run always evaluates the saved version and invalidates displayed plans after input changes. Unknown outcomes retain the key for exactly unchanged saves; no backend PII errors or fake sent/executed states are shown. Response contracts and returned scope/version/input/posture are validated before success display.

## Validation and deployment

Use **only** disposable localhost `hon_automation_validation`, exact migration role `hon_automation_owner` and runtime `hon_automation_runtime`; inherited remote URLs are explicitly rejected by fixtures. All numbered migrations and canonical 010 are applied with guarded local role aliases. Root commands: `pnpm check`, `pnpm test`, `pnpm build`, `pnpm db:check`; database commands: `pnpm db:verify-rls` and `pnpm db:test-automation-rules` under the explicit local URLs. No remote migration is part of this change.

Integrity tests prove exact human/permission/scope denial and revocation, invalid condition/proposal/authority and SQL bypass rejection, disabled/no-plan and TypeScript/SQL deterministic parity, zero dry-run persistence, optimistic version/idempotency/concurrency, real lock-observed expiry/revocation, atomic audit/outbox/receipt rollback, no domain/AI/provider/Action Engine/communication/payment effects, directory ACL denial, canonical/JS drift failures and actual-row non-bypass table-owner FORCE-RLS. API HTTP tests prove same-origin/exact command/closed DTOs and absent execute/send/publish endpoints. Web tests prove inert initial state, fixed same-origin transport, retained retries/history separation and rejected fake actionable responses.

**Local validation status: complete.** The disposable automation-role integrity suite passed, including canonical and JavaScript verifier drift probes and actual-row owner FORCE-RLS proof. Clean root `check`, `test`, `db:check`, and `build` also passed with both database URL variables unset. No remote database, provider, AI, or automation execution was used.

Privileged migrations/canonical ACL changes need operator review/application before remote runtime availability. Commit/push and local/public page HTTP checks do not assert deployment or authenticated remote saves. Missing boundaries remain unavailable. A future executor, event ingestion, real-event authorization, advanced tier descriptors, scheduler and domain approval workflow are separate unimplemented work, not latent authority in these rules.
