# Family account frontend — dependent draft

This frontend uses PR #136's exact closed contracts, currently backend head `324072e321a8192a1ac62f0aea3c88daa5b657f7`, targeting `claude/parent-invitations`. It does not approve that backend or modify its migrations. Preserve the backend's independent review and owner merge gates.

- `/staff/family-access`: explicit exact organization/school selection, the existing bounded `families` read, and a final current family-manager invitation read before revealing any records. Choose an actual returned active family before inviting one email to PRIMARY_GUARDIAN, SECONDARY_GUARDIAN or VIEWER access. Revoke only a returned PENDING invitation; end only its returned ACCEPTED grant, with separate human confirmation. A historical receipt is not current access.
- `/account/family-invitation`: normal signed-session gate, explicit current-identity verification, pasted invitation ID/code and deliberate confirmation. Email/subject/roles are never supplied by the acceptance body. Mixed staff/parent conflicts require school review and latch further acceptance retries, including after an earlier UNKNOWN result; unresolved evidence is retained until deliberate abandonment.
- Match the existing owner-invitation custody model: share the fixed acceptance link and ID/private code separately through an approved secure channel. No code in URLs, fragments, logs, analytics or browser storage. HON sends no email or SMS.

Privacy immediately hides/inerts private DOM on blur, visibility loss, pagehide, school change, session invalidation and unmount. Read revisions reject late results. Scope-selector edits retire the old scope synchronously. Normal school changes need a fresh explicit binding; an unsettled request stays owned by its original mounted controller and can only reconcile after explicit original-school and same-subject reauthorization. A separate-tab sign-in link preserves mounted recovery. The original URL/body/key/token remain immutable through UNKNOWN and later denial. Discard is unavailable while active; deliberate abandonment warns it cannot reverse server effects. Full document destruction loses private recovery. No automatic consequential retry.

A validated command response is held privately until post-command identity verification. Concealed settlement requires explicit authorized restoration and never automatically repeats the mutation. Known settled evidence can be revealed after fresh same-school/identity checks without another POST. Retained callback revisions are retired before releasing the command lock.

## Deliberate gates

The current backend contains a narrow suspension-time revocation/termination exception, but the owner requested that its frontend stay disabled until independent backend review. This screen therefore conceals records/actions on the denied suspended-school list and does not expose a bypass. No paid access, billing, AI, identity merge, provider, delivery or school activation is implied.

The family and invitation windows are bounded at 100 and 50 respectively. Absence from a returned window is not absence of history. Broader CRM/navigation integration, real identity-provider login, backend approval and Manus's private owner environment remain separate integration gates. No owner-accessible URL is claimed.

## Verification boundaries

Focused controller, transport and server-rendered presentation tests use explicit mocks and synthetic records. They cover live-scope failure handling, confirmation/callback retirement, exact recovery, post-command identity switches, UNKNOWN followed by denial/review, and EN/KO/ES. These are not real database evidence.

`family-access-ui-validation.yml` runs on the exact dependent PR head. It reuses the unchanged #136 real signed-session/PG proof, then exercises actual frontend transports → production Next → signed-session Nest/IAM → restricted marked disposable PostgreSQL, with post-commit response loss, replay, tenant/role denial and persistence. Its mounted browser tests use real responses (only deterministic response loss is injected), 27 language/view/viewport combinations, keyboard focus, screen-reader status, scope changes, acceptance/reload/end and axe. External browser destinations are blocked; static fonts use installed local fallbacks. No live OIDC provider login or customer environment is tested. Local sockets/PG are unavailable: do not report hosted tests as passed until their exact-head workflow actually succeeds.

### Executed local evidence before publication

- 74 focused frontend regressions passed (37 controller, 25 transport, 6 presentation and 6 page-session tests).
- Complete web suite: 1,382 tests passed in 152 files. Web TypeScript and production Next build passed.
- All 188 migration checksums in this dependent backend tree passed unchanged. This is the PR #136 tree inventory, not a claim that it already includes newer accepted-main migrations.
- Harness JavaScript syntax, two-job workflow YAML parsing, 99-route manifest uniqueness and whitespace validation passed.
- Four reported identity/UNKNOWN-denial regressions and two later timeout/post-verification-unavailable regressions failed before their corresponding corrections and pass afterward. Separate controller tests cover school-context retirement and explicit same-scope recovery.
- No local API/PostgreSQL/browser run is claimed: local socket/DB capabilities remain unavailable. The hosted real signed-session and mounted-browser jobs must still execute on the published exact head. Backend independent review, source acceptance and final current-main reconciliation remain gates.

A denied list read conceals actions; this does not prove an atomic frontend suspension restriction across a subsequent POST. The proposed backend may allow narrow revoke/end after a school suspends. Its independent review and owner release approval remain mandatory before this dependent UI is operational. No frontend preflight substitutes for that authority.
