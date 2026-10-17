# HON OS — Claude Code repository entry point

This is the **existing live development repository** for HON OS, a security-sensitive, multi-tenant SaaS system. Manus and Claude may contribute to the same GitHub repository. **Do not initialize a new project, replace existing architecture, or discard work.**

## Read in this exact order before proposing changes

1. [AGENTS.md](AGENTS.md) — existing mandatory engineering and security instructions; these take precedence over generic advice here.
2. [docs/EXTERNAL_AGENT_HANDOFF.md](docs/EXTERNAL_AGENT_HANDOFF.md) — current code map, validated behavior, collaboration and approval requirements.
3. [docs/HON_MASTER_DIRECTIVE.md](docs/HON_MASTER_DIRECTIVE.md) — existing technical/product mandate.
4. [TODO.md](TODO.md) — current dependency-aware tasks and evidence. It is large: focus on relevant sections rather than rewriting it.
5. [docs/hon/README.md](docs/hon/README.md) — **owner-approved business vision, commercial decisions, acquisition plan, and operating goals** newly integrated for Claude.
6. Relevant exact contract in `docs/architecture/`, code, migrations, and tests for the assigned feature.

**Authority when documents conflict:** newest explicit owner instruction > existing repository authority hierarchy. The business-vision docs describe intended future functionality, not proof that something is deployed or a grant of permission. Never interpret business pricing or AI allowances as active charges, live entitlements, or provider balances.

## HON mission

**HON OS — The AI-powered operating system built to run and grow martial arts schools.** Deliver a reliable school CRM plus actual school marketing workflows and attributed growth; Complete adds seven governed specialized AI employees. HON HQ must eventually manage HON's operations without developer prompts. **Manus builds/adjusts HON; HON HQ operates HON.**

New public plan intent: **Core $149/mo / 5,000 planned premium credits**, **Complete $249/mo / 12,000 planned premium credits**; founder $79/$149 monthly, original paid lifetime $1,896/$3,576 with full ongoing monthly tier allowance for the purchased tier. All amounts are owner-approved **future commercial policy**, not current payment activation. **Essential remains supported for legacy records and entitlements**; do not remove or reprice existing subscribers. Do not confuse the proposed founding lifetime inventory with lifetime memberships earned through qualified referrals.

Day-one commercial-launch goals include: 30-day refund guarantee, truthful founder offer, **HON Champions Club** referral invitation links and verified leaderboard, $100 new-school welcome credit, and an **HQ-configurable referral contest builder**. Association partnerships come **after demonstrable proof of concept**, not as the first channel. Consult `docs/hon/` before touching these workflows.

## First Claude session is READ ONLY

Inspect `git status`, latest `main`, current branches/PRs, package scripts, auth, RLS, migrations, plans, AI Action Engine, HQ, marketing connectors, payments, and tests. Report **verified / partial / mock / blocked / absent**, with file references. Coordinate current file ownership with Manus. Propose ONE bounded non-overlapping task before editing. No code changes, paid calls or deployments without explicit task authorization.

## Mandatory change discipline

- Work on `claude/<feature>` from fresh main using a separate checkout/worktree. Do not edit Manus's dirty workspace or force-push main.
- Trace UI -> API/guards -> domain service -> contracts -> database/tests. Use existing tenant scope, forced RLS, idempotency, audit/outbox, human command paths, and governed AI Action Engine.
- Never infer permission from selected tenant/school, UI appearance, an agent persona, or URL/query/form values. Do not bypass HQ/school/family boundaries.
- No new external spending, messages, ads, live payments, refunds, remote database changes or deployment without explicit owner approval. No secrets or real family/student data in commits or examples.
- Run focused validations, and when relevant `pnpm test`, `pnpm check`, `pnpm build`, `git diff --check`; give **actual** results, not assumptions. Use disposable-local DB fixtures only.
- Open a narrow PR with changed files, risks, security boundary, evidence, required owner decisions, and untouched effects. No fake metrics or claims that an inert screen is functional.

## Business references
- [docs/hon/PRODUCT_VISION_AND_PLANS.md](docs/hon/PRODUCT_VISION_AND_PLANS.md)
- [docs/hon/OWNER_COMMERCIAL_POLICY.md](docs/hon/OWNER_COMMERCIAL_POLICY.md)
- [docs/hon/CHAMPIONS_CLUB_AND_GROWTH.md](docs/hon/CHAMPIONS_CLUB_AND_GROWTH.md)
- [docs/hon/HQ_AUTONOMY_AND_AI.md](docs/hon/HQ_AUTONOMY_AND_AI.md)
- [docs/hon/IMPLEMENTATION_AND_COLLABORATION.md](docs/hon/IMPLEMENTATION_AND_COLLABORATION.md)

Do not run `/init` to overwrite this entry point.