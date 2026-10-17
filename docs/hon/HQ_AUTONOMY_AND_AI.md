# HON HQ must operate HON, with developers needed only for engineering

## Organizational principle

**Manus develops HON. Claude can help develop HON. After launch, HON HQ operates HON.** These coding tools must NOT be required at runtime to start contests, adjust preconfigured prices/promotions within safeguards, manage accounts, publish approved website content, allocate approved AI policy, reconcile support tickets and review metrics. A future full-time engineer inherits an independently deployable codebase.

HON HQ is a high-trust, separate company operator plane, not a back door into student/family/school data. Identity -> HQ grant -> exact organization/school authority -> permission -> policy -> approval -> audit, never bypassed by owner-themed UI or AI agent persona.

## HQ business control surfaces (target capabilities, not implemented claims)

- Organization/school directory, owned multi-location relationships, tenant lifecycle, authenticated support access, provisioning, suspended/restored accounts, and secure asset ownership transfer with source/target authorization.
- Versioned plan catalog: Core/Complete, grandfathered Essential, founder/annual/lifetime grants, coupons, payment term and tier functionality changes enforced across API and UI.
- Provider cost and premium credits: actual per-operation incurred cost, allowance issuance/reset, ledger, available versus reserved/spent credits, vendor reconciliation, alerts and gross contribution by tenant/tier.
- HON company marketing: create and schedule *HON's own* landing pages, referral campaigns, social assets and provider-connected ads within approved budgets and owner publication steps.
- Permanent referral program and optional scheduled, owner-activated contests. Verify milestones, dispute/refund eligibility, prize selection, fulfillment budget, public opt-in leaderboard, fraud checks.
- Finance and support: tickets, escalation, reports, payment processor webhook reconciliation, refund approvals, subscription/customer status and churn, durable audit logs.
- Operations and releases: health/uptime, task failures and approvals, feature flags where designed, backups/restore/monitoring and secure staff roles.
- Admin work using readable named objects and verified statuses, not raw UUID forms as the normal user experience.

A proposed HQ action (e.g. "Launch a 30-day contest with a gaming console, family theme-park tickets, and a Visa gift card") should create a governed **DRAFT** with costs, eligibility, dates and legal terms. Owner must approve before publication/spending. HON can execute the approved configured workflow and produce verified receipts; no developer prompt required.

## AI workforce architecture

One HON-governed intelligence/action platform, task-appropriate model routing and cost policy. **One model/persona does not equal one unrestricted autonomous worker.** The school Complete specialist roles are Alex (manager), Chad (enrollment), Maya (student success), Marcus (marketing), Jordan (operations), Claire (analytics), Lena (creative/commerce). The Master Directive also includes Eian as a platform personality; do not erase the existing eighth profile when building the seven specialist entitlement boundary. HQ AI executive-team roster remains distinct and cannot borrow school authority.

Agents have presentation personalization: name, appearance Realistic/Anime/Chibi, tone, voice. None changes tenant permissions, cost quota, system identity, or tool authorization. Owner-selected AUTO / CONFIRM / RESTRICTED applies **at the action level** with the most restrictive effective policy, mandatory server guard, approval binding, scope proof and audit.

School Core: reliable human domain work, ordinary contextual HON assistance included with model routing/fair use. School Complete: all Core plus only those **real** verified specialist tasks that have typed tools/authority; never manufacture apparent job completion from generated chat. Provide visible pending, approval-required, scheduled, failed/retry and provider-unavailable states.

## Durable provider boundaries

Payments, external Meta/Google ads, email/SMS/voice/push, media generation and other external providers must have scoped account connection, explicit required consent/approval and budgets, idempotent jobs with traceable receipts, failure/UNKNOWN reconciliation, and secure secrets. No silent ad spend or customer contact. Keep provider adapters substitutable and honor privacy requirements for student/guardian data.

## Independent source and handoff

- GitHub repository `myhonosai/honos` is canonical source.
- GitHub push is not production deployment; Manus previously disabled auto-publish.
- HON-owned infrastructure, reproducible builds, automated tests, app/DB migration and rollback playbooks, encrypted secrets handling, observability, incident/recovery runbooks and secure developer access should be delivered for future full-time staff.
- Never make HON depend operationally on an open Manus conversation, hidden agent-only instructions, or a single provider's proprietary runtime.

## Source constraints

Architecture mechanisms and exact implemented endpoints reside in `docs/EXTERNAL_AGENT_HANDOFF.md` and `docs/architecture/*`. This document describes owner intent and must not be used to activate unimplemented providers or permissions.