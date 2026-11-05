# Staff account invitations — frontend slice

This is a dependent frontend for Claude's PR #135 at `9e8e9535948bd171ac8f424ced7777d2334d7f5d`. It does not make that draft backend approved or deployed. No schema, migration, permissions or account API is authored here.

## Implemented boundaries

- `/staff/team/invitations`: explicitly verify the signed-in identity and the school-scoped invitation read; read/select an existing known custom role; invite, review the latest 50 invitations, or revoke a currently pending invitation.
- `/account/staff-invitation`: authenticated, explicit acceptance using the invitation ID and private token entered separately. No query-string token, email matching, client role or organization authority.
- Existing `/staff/roles` links to the new screen; return links use the existing protected `/staff/dashboard`, without silently depending on #134's unmerged entry route. All operations use the exact #135 contracts and human-command header. Backend IAM, live entitlements, grantability and verified email remain authoritative.
- Tokens use 32 cryptographically random bytes. The generic acceptance URL, invitation ID and token are manually shared through an approved secure channel. HON sends nothing. The server cannot recover the token.
- EN/KO/ES, three presentation modes, responsive controls, persistent live status and deliberate focus recovery after user-requested reads/commands. Presentation changes do not read account data.

## Privacy, outcome and recovery

Blur, hidden visibility, pagehide, shared session invalidation, school changes and unmount synchronously conceal/inert private DOM, retire read revisions, abort reads and reject stale results. Every protected read checks the original signed subject before and after. Scope/role edits retire prior confirmation callbacks synchronously.

Commands have an independent unsettled lifetime. Their exact original path, serialized body and key remain in mounted private memory. No automatic replay or replacement command is allowed. A visible receipt requires a fresh matching post-command identity check; a silent session change during POST cannot disclose its receipt or token. A settled concealed receipt requires explicit original-actor/school reauthorization before display.

If post-command verification fails, the original request remains unresolved and requires fresh original-actor authorization plus explicit exact replay. A 401 broadcasts the existing shared invalidation signal; a 403 stays local. An old unmounted command cannot invalidate a replacement session. Explicit verification can restore the original identity after reauthentication without automatically resending or discarding the original request.

ACCOUNT_REVIEW_REQUIRED latches recipient review across exact retries, read refreshes and deliberate local abandonment. The browser has no authority to declare the review resolved. Mixed staff/parent identities must be reviewed by the school; email equality is never sufficient. Accepted-role revocation remains a separate existing staff-role command.

No abandonment is available while a command is unsettled. After settlement, deliberate abandonment requires acknowledgement that it clears only local recovery and cannot undo a server action. A native leaving-page warning protects pending recovery. Full document destruction still loses private keys/tokens; it does not cancel a server command or resolve a required review. A new document is not evidence the school completed that review.

## Current backend gaps

The existing staff-role API supports only `GET .../staff-roles/custom/:roleId`, not the role-list reader mentioned in the #135 handoff. The UI accurately shows discovery as unavailable and permits an explicitly authorized known-role read/selection. Codex requested a minimal bounded eligible-role picker contract from Claude in Sprint Coordination #131; no list API is invented here. Organization/school inputs are untrusted selectors, not scope proof.

No recipient preview/read-resolution API exists. Forbidden acceptance intentionally does not disclose whether an invitation is expired, revoked or absent; copy says to contact the school without asserting existence. No school-wide staff directory, email delivery, parent linking, dual-role resolution, paid access, AI spending or commercial activation is introduced.

## Verification and limits

Focused controller/transport/server-page/component lifecycle/localization regressions cover immutable retries, busy/rate refusals, UNKNOWN → review-required, post-command identity changes, 401 versus 403, scope changes, concealment, read retirement and no false receipt. Hosted `.github/workflows/staff-invitations-frontend.yml` checks the web suite/type/build/migrations and reuses #135's actual signed-session authorization proof.

`apps/web/scripts/staff-invitations-verification.mjs` is guarded to the exact marked Champions localhost disposable database and GitHub-hosted environment. It uses actual frontend transports/controllers, Next, signed HON sessions, Nest services, runtime IAM/RLS and PostgreSQL; actual committed response-loss/exact replay and no unrelated-table changes are asserted. It prepares 27 mounted language/mode/viewport combinations, three recipient acceptance flows and accessibility/screenshots. External page requests are blocked; known static-font requests use installed local fallbacks. Cookies contain only scoped synthetic language preferences; remote language persistence is not claimed.

Executed locally: 64 focused regressions; the complete web suite (1,372 tests in 153 files); web TypeScript and production build; all 187 backend-base migration checksums; harness syntax, workflow YAML and whitespace checks. The first full web run found the two new pages missing from the route manifest; both entries were added and the final full suite passes. Two preparatory-read ownership regressions failed on the prior committed source and pass with abort ownership; a retired pre-command read cannot invalidate a replacement session.

Local sockets/PostgreSQL/browser execution are unavailable. Hosted API/browser results remain pending until the exact published head runs. Neither synthetic browser results nor signed-session fixtures prove external OIDC login, owner-device access or a real owner-pilot environment. Existing unchanged full backend proof evidence is reused; the final accepted-main combined candidate still requires complete integration CI and independent review.

No PR merge, deployment, provider call, external communication, persistent database mutation or real-school activation.
