# Codex HQ Champions Club frontend integration

Owner-authorized follow-up on `codex/hq-champions-integration`, stacked on `codex/hq-modern-implementation` / PR #8. Tracking issue: #4. No merge or deployment authorized.

## Verified foundation

Main `ba1866a` merges Claude's Champions Club M3 (PR #10), following M1 and M2. Merged contracts and APIs were read directly from that immutable main commit. The earlier backend architecture notes' “not merged” status text is historical; commit history establishes the current merge state.

PR #8 was reported by the connected GitHub API as mergeable/clean when inspected, rather than currently conflicted. Latest main introduced no HQ frontend edits. Main was incorporated unchanged in merge commit `998beb3`, with an additive preservation of the Codex TODO section. No frontend or backend was discarded. PR #8 remains independently reviewable and unmerged.

## Vertical slice

`/hq/growth/leaderboard` now uses `GET /api/v1/hq/champions/leaderboard`, through the existing Next API rewrite to `/v1/hq/champions/leaderboard`.

- All-time or selected UTC month, refresh, loading, authorized-empty, denied, invalid-filter, unavailable and invalid-response states.
- Shared `validateChampionsLeaderboardQuery` and `validateChampionsHqLeaderboard` contracts; a closed `{ data }` envelope and exact requested-period match.
- Official ranks, positions, qualified/pending counts and order are displayed as returned. No browser sorting, qualification, rank calculation, padding or fictional totals. Top 100 limit and total-ranked count remain explicit. Pending counts and held-school qualified totals are all-time even in the monthly view.
- School/organization names are shown only from the authorized HQ response. School-view display consent is described separately; no public/school publication is introduced.
- Confidential HQ holds appear in a collapsed, separately labeled review section, never among ranked rows. A review is not described as proven fraud. No hold placement/release commands.
- Filter changes/refresh immediately hide old facts; AbortController, effect cleanup and a request key prevent obsolete responses from restoring them. No persistent client cache or URL-derived scope/authority.
- The two appearance groups have their own rounded borders, label and spacing. They stack on mobile without changing presentation permissions or persistence.

## Security

The existing signed-session `/hq` layout and strict overview gate are unchanged. The Champions Club API independently resolves `HON_HQ_OWNER` or `HON_HQ_OPERATOR` with `hq.champions.manage`; the frontend does not infer Champions authority from overview access. Support, school, family, delegated and AI authority remain excluded by the existing backend. No school endpoint fallback or direct database access exists.

Transport is a fixed same-origin authenticated GET with `cache: no-store`, redirect errors, no referrer and no body/authority headers. Error bodies are not read or echoed. Invalid/denied data never populates the standings or hold list. Application code contains no fixture rows or command transport.

## Verification plan and isolation

Unit tests cover the exact transport, selector injection, strict response/privacy/order validation, period mismatch, denial-body non-disclosure, unavailable behavior, official ties, separate holds, escaped names and initial data-free SSR. The browser harness runs the actual production build with ephemeral signed sessions and synthetic localhost API fixtures. The fixture verifies the signed identity independently, has a fixed authorized HQ identity allowlist, denies school/family/support/unsigned identities, rejects unknown routes/selectors and permits GET only. This is a transport double, not proof of production authorization; existing disposable-database M1–M3 proofs separately verify canonical backend authority and calculation.

Browser checks cover all-time/month selection, server order, refresh to changed data, loading/empty/errors, access revocation, stale-response isolation, confidential reviews, four viewport widths, all appearance modes, separate appearance boundaries and axe scans. Fixture data lives only under scripts/tests, visibly labeled `LOCAL TEST FIXTURE · NO LIVE DATA` in captures.

The established `ci.yml` only triggers PRs targeting main. The existing Codex-owned temporary workflow is narrowly extended to the exact same-repository stacked branch/base pair. It runs the same repository test/check/build/migration commands and existing disposable-local PostgreSQL proofs using pinned setup actions and a read-only token. The shared CI workflow, lockfile and security infrastructure are unchanged. Remove the temporary workflow after owner sign-off.

Local React/Next/TypeScript/Vitest dependencies remain absent. This exported checkout has no origin remote, so main was fetched through the connected GitHub app and exact blob/tree verification. The managed environment reports enforced HTTP policy but exposes no repair capability. No repeated download attempts or proxy/security bypasses were made.

## Deferred until this slice is tested

Phase 3 program/attribution/statistics/milestone/liability page integrations remain separate follow-up work. Their merged contracts were verified, but those pages retain truthful unconnected states in this slice. Reward liabilities are not payments; no issuance, reward reconciliation/approval, financial activation, contest lifecycle or hypothetical M4 API is added. Claude's backend and Manus's school CRM/enrollment/membership files are untouched.

Actual CI results, screenshots and remaining manual review will be recorded after execution. Physical-device keyboard, screen-reader and owner review are separate from automated accessibility checks.
