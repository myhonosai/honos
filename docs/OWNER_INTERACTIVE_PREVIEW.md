# Open the actual HON OS application privately

This branch integrates **main `6ab871cd781935fc633dfec7685075b3d95432be`**, **Founder Setup #94 `1beba39b3c7b01f4b11b2872eeba820ca5231275`** and **CRM journey #95 `a804f3fc923f2c8e439db68ba92f1091201c45df`** for owner review only. Neither PR is merged into main by this branch. Their application files are retained byte-for-byte. `source-lock.json` pins their critical source files and launcher startup checks them.

**Access status:** setup is prepared; no Codespace has been created, no external HTTPS preview URL is claimed, and owner-only GitHub forwarding has not been independently tested. The Codex connection cannot create or administer a Codespace. CI runs the real mounted app locally with synthetic authorization; that is not proof of the GitHub gateway. See the preview PR for exact executed results.

## Shortest owner setup

1. Sign in to GitHub as the repository owner. Check **Settings → Billing & licensing → Codespaces** for included compute/storage and a stop-usage spending policy. Do not create a Codespace if extra spending could occur without your approval. Actions and Codespaces have separate allowances.
2. Open [this preview branch](https://github.com/myhonosai/honos/tree/codex/private-interactive-preview). Select **Code → Codespaces → New with options**, verify the branch, choose the smallest 2-core machine and create it. Do not grant repository/production secrets or enable paid prebuilds. Wait for container setup; it pins Node **22.23.4** and pnpm **10.18.0** without installing the app or starting services automatically.
3. Open **Ports** in the bottom panel. For **3000**, choose **Port Visibility → Private**, not Public or Private to Organization. Keep protocol **HTTP** (GitHub supplies HTTPS externally). Only 3000 is forwarded; never forward **3001** or **3100**. The standard devcontainer format cannot enforce visibility, so check it in the UI even on a reused Codespace. Stop if owner-only Private access is unavailable.
4. Open **Terminal → New Terminal** at the repository root and run these four lines, waiting for each to succeed:

   ```bash
   export HON_PRIVATE_PORT_CONFIRMED=1
   pnpm install --frozen-lockfile
   node apps/web/scripts/private-preview/prepare.mjs
   node apps/web/scripts/private-preview/start.mjs
   ```

   `prepare` builds existing workspace packages and the real Next.js web app. It runs no database or migration. Stop on an error; do not disable TLS, edit the lockfile or repeatedly retry a blocked install. Remove no production settings: create a clean Codespace instead. The launcher rejects `.env` files, ambient database/provider secrets, production/staging identity and a non-loopback API override. Errors omit values. If a shallow Git clone causes `PREVIEW_SOURCE_CHECKPOINT_MISSING`, run `git fetch --unshallow origin` once, then start again; do not remove the source check.
5. Leave the terminal running. It prints a **temporary synthetic-preview access code**, not a production credential. In **Ports**, click port **3000 → Open in Browser**. Copy the actual HTTPS address GitHub assigns. Enter the terminal's temporary code in that page. The root URL opens the preview gate; after unlocking you reach `/__preview`.
6. On a phone, sign in to the **same GitHub account** and open that actual URL. A second preview-code unlock may be needed. Do not send the code to others or switch visibility to Public. No URL was generated before these owner actions.
7. In a separate **signed-out/private browser**, open the HTTPS address without logging into GitHub or entering the code. It must be blocked by GitHub authentication and show no HON content. If it exposes the preview gate or app, stop the server and correct port visibility. The additional code gate does not replace owner-only forwarding.

## What to click

The wrapper only provides navigation, synthetic identity switching and truthful labels. The application inside it is the repository's actual production-built Next.js/React routes, assets and components. No replacement dashboard or simplified CRM was created.

| Surface | Real frontend behavior | Fixture / unavailable boundary |
| --- | --- | --- |
| School A / School B owner dashboard | Existing automatic exact-one scope resolution, aggregate dashboard and presentation selector | Two independent synthetic organizations. Counts come from in-memory sample records, not a live database. Unsupported Owner Launch subreads stay unavailable. |
| Founder Setup #94 | All eight guide stages, Previous/Next/direct/support navigation, searchable help, synthetic example, privacy shield and new localized screen-reader stage status | Explicit existing-contract reads return minimized sample school facts. Visiting stages is not completion. Shared durable setup progress, profile edits, invitations and support delivery are unavailable. |
| Connected CRM journey #95 | Load leads; select Rivera or Lee; internal follow-up; future trial time; outcome; WON/LOST; optional adult/child registration record; explicit confirmations, refresh barriers and retries | Every command touches **this process's sample state only**. A registration record is not paid membership, agreement, enrollment completion or activation. Advanced family recovery remains review-required. No real person or school changes. |
| CRM Leads / Follow-ups | Existing staff workbenches and their explicit reads | Lead route receives inert sample scope selectors, independently checked by the fixture. No new production endpoint. Unsupported commands/readers remain unavailable. |
| HON AI team | Actual HON plus seven-agent workspace, portraits, tabs and governed-status UI | Real conversation runtime is not merged; composer stays unavailable. The wrapper's optional **Scripted illustration** is deterministic text, clearly not AI generation, agent work or a sent message. No provider/credits. |
| HQ dashboard / school directory / Founder readiness | Actual separate HQ shell, menus, modes, directory and guide | HQ profile can read the two synthetic schools. Actual progress remains unknown; any progress example is explicitly synthetic. HQ business mutations, invitations and offer publication remain disabled. |
| Language & Region | Existing EN/KR/ES controls, localization and formatting | A synthetic preference is kept independently per preview profile in process memory. It resets on launcher restart; this is not real account or cross-device persistence. Broader untranslated screens remain as implemented. |
| Design reference | Original HON design/reference routes and appearance controls | Historical reference copy and sample metrics are illustrative, not current commercial offers or real activity. Missing legacy art is preserved rather than silently replaced. |

Try the **Connected CRM journey**: first click **Use my current school** (한국어: **내 현재 학교 확인**; Español: **Usar mi escuela actual**), then explicitly choose Rivera or Lee from the returned lead selector. **Load / refresh leads** stays disabled until the school is resolved; no manual UUID or URL-based authority is needed. Record an internal follow-up, explicitly refresh, choose a future start/end for a trial, confirm, refresh, record the trial outcome, refresh, close WON, refresh, then optionally prepare registration. Read every confirmation. The software's refresh/privacy/retry protections remain active, so switching browser windows can conceal facts and require explicit access restoration.

Use each screen's own Modern / Classic / Big Button controls where implemented and its EN/한국어/Español selector. Presentation changes confer no authority. Not every old module is fully localized or has all three mode implementations; this preview does not manufacture parity. Test desktop, tablet and phone, including keyboard Tab/Enter/Space. Some existing floating HON/mobile bars can overlap content at particular scroll positions; report that position rather than changing the global design here.

## Synthetic identity and privacy

- The only preview profiles are fixed server-owned HQ, School A owner and School B owner. No arbitrary role, organization, school, subject or credentials can be supplied. Selecting a profile is a preview action behind the private/code gates, never production authority.
- **Reset private view & switch** replaces the ephemeral signed subject, revokes its old fixture authority, destroys the mounted iframe and clears private client state. Old requests fail closed, including after asynchronous body/response waits. Finish sample commands before switching: full document destruction loses local retry keys and cannot reverse an already simulated action. No browser storage is used for preview access/retries; HttpOnly short-lived cookies hold only synthetic session identifiers.
- Existing session verification and page guards remain unchanged. The fixture API verifies real `@hon/auth` signatures with a newly generated process-only key and separately checks the active fixed profile and exact scope. Its authorization is **synthetic**, not proof of actual IAM/RLS. The key is never printed, written or sent to the browser.
- Only loopback ports are bound. The gateway forwards to one fixed local Next server; its only configured API rewrite goes to the loopback synthetic responder. Unknown APIs refuse locally; there is no live fallback, database, provider SDK, real OAuth login or customer data. Browser CSP blocks external resources/connects/forms; startup gives Next a minimal environment without inherited credentials.
- Preview controls require an exact same-origin POST and a private access code or CSRF token. Existing HON JSON transports deliberately suppress referrers; if their browser serializes Origin as `null`, mutation forwarding additionally requires the forbidden browser-generated `Sec-Fetch-Site: same-origin` value. This is only CSRF defense; the independent cookie, signature, current identity, exact scope and closed command checks remain mandatory. No foreign/missing origin fallback or proxy trust creates authority. The wrapper sends only an origin-level referrer, never a path, query, code or retry key.
- One-hour code-gated browser sessions expire; restarting erases all sample state, code and signing material. Lock/unlock for a fresh synthetic session. Normal sign-in/provider routes are intentionally unavailable in this fixture environment.

## Evidence and remaining gates

The preview workflow validates source pins, startup refusals, closed fixture contracts, cross-role/school denials, exact retries, identity replacement, actual route navigation, mounted desktop/mobile behavior, languages/modes and accessibility. Screenshots/reports are private GitHub artifacts; synthetic browser results are never described as real database/provider tests. No individual screenshot upload is needed.

Unverified until owner execution: Codespaces container creation, quota, actual private HTTPS forwarding, signed-out GitHub denial and physical device/screen-reader behavior. No external preview URL or live launch is claimed before that check. Independent review remains required for this preview and PRs #94/#95; none are source-merge or operational-launch approvals.

## Stop and costs

Press **Ctrl+C** in the server terminal. Then use [GitHub Codespaces](https://github.com/codespaces) **… → Stop codespace**. Closing the browser or stopping Node alone does not immediately stop compute. Use a short idle timeout (for example 15 minutes); storage can accrue while stopped, so delete the disposable Codespace when finished after preserving intended Git work. Do not enable prebuilds, providers or extra machines. Nothing here creates a Codespace or incurs Codespaces usage automatically.
