# Implementation truth, Claude/Manus workflow and first assignment

## Verified repo facts and current reported state, 2026-10-17

This memo is based on GitHub read-only listing and the repository's existing technical handoff, **not** a full source audit or runtime deployment proof.

- Private canonical repo: `myhonosai/honos`, branch `main`, with `apps/web`, `apps/api`, `packages/`, `docs/`, `infra/`, `AGENTS.md`, `TODO.md`, `pnpm-workspace.yaml`.
- Engineering stack described by existing handoff: Next.js/React frontend, NestJS API, shared TypeScript contracts/domain, PostgreSQL + forced RLS.
- Existing dated technical handoff at `docs/EXTERNAL_AGENT_HANDOFF.md` identifies validated bounded workbenches, platform/HQ foundations and critical deliberate external-provider blocks; read it rather than relying on this snapshot for live status.
- Public Core $149/Complete $249 and 5,000/12,000 AI allowances in `packages/config/src/public-plan-catalog.ts` are **display/planning metadata only**. Existing Essential records remain valid and compatible. No commercial activated plan grant, payment or Core allowance follows from the display catalog.
- Existing Core/Complete entitlement audit notes partial specialized agent drafts and narrow credit usage paths; not a broadly functional AI company. Meta/Google live provider integrations and processor billing not complete. Day-one referral/leaderboard/contest is owner-approved **future requirement**, not a proven running system.
- Existing repository agent handoff was committed by Manus; do not replace or supersede its domain/security constraints.
- Manus may still be editing `main`; confirm current HEAD and assignments every session.

## Claude / Manus coexistence policy

1. Read `AGENTS.md`, existing technical handoff, directive, current `TODO.md`, business documents, and exact relevant architecture contract.
2. Check remote branch, commit, dirty worktree, active PRs and changing files; preserve uncommitted code. Do not share a working tree with Manus.
3. Claude uses a separate `claude/<bounded-feature>` branch, preferably separate worktree. Coordinate non-overlapping modules. No force push; do not automatically protect main in a way that breaks Manus without owner-approved transition plan.
4. Before implementation, identify a **single complete vertical outcome**, route -> transport -> controller/guard -> service -> contracts -> DB/test shape, changes and acceptance criteria; do not create a parallel architecture.
5. Implement with strict tenant/HQ separation, permissions, audit/outbox/idempotency, Action Engine policy, real data and receipts, unchanged external spending without approval.
6. Test focused unit/browser/API/SQL integrity, RLS in a **disposable local DB** where affected, plus `pnpm test`, `pnpm check`, `pnpm build`, `git diff --check` as warranted and safe.
7. Open a focused pull request; report exact code/test changes, provider/deployment **non-effects**, blockers and owner approvals. Wait for review/merge when appropriate.
8. After merge, fetch current main again; never build against stale SHA. Update `TODO.md` with verifiable delivery evidence, not estimates.

## Claude first session — READ ONLY

**Task:** audit real code status and choose the smallest safe non-overlapping next feature. Report a matrix for auth/tenant RLS, Core conventional lifecycle, plan catalog, legacy Essential, HQ, AI Action Engine/credits, Meta/Google connectors, Stripe/payment, school/parent data, referral invitation and contest and tests. Label each **verified working, partially built, design/UI only, provider-blocked, missing**. Cite exact file paths/tests. Compare with locked owner policy and `TODO.md`; identify top ten gaps and recommend next three bounded implementations. Do not change code, create provider connection, call paid APIs, alter production data or deploy in that first session.

## Suggested priority sequence — dependent on audit, not automatic task approval

1. Preserve secure school onboarding/lead-trial-enrollment working flow; improve existing human routes and friendly navigation without weakening RLS.
2. Complete core operational domain functionality, owner billing/policy decisions and school-to-family flows; test every human action independently of AI.
3. Implement actual HQ-only Core/Complete/legacy entitlement and **commercial** billing ledger in approved steps, plus ordinary HON assistant policy and provable premium allowance rules.
4. Build honest Meta/Google connectors, consent/approved manual campaign flow, receipts, attribution and governed Complete optimization when external access is ready.
5. Build the commercial Day-one Founding 50, 30-day guarantee, HON Champions Club invitation/qualified referral/real leaderboard and configurable HQ contests, with approved monetary terms.
6. Expand HQ self-operation, support, durable executives and operational observability; prove no Manus-dependent business campaign editing.

Do not treat dependency priority as permission to defer an approved Day-one launch feature past the commercial launch.

## Acceptance threshold

A user completes a real authorized workflow with persisted correct records, negative/tenant tests pass, UIs distinguish draft/pending/active/error, no fake metrics, full stack contract is consistent, owner permissions and approvals observed, and the PR documents tests, limitations and deployment non-effects.

**Never claim product completion based solely on visually polished screens.**