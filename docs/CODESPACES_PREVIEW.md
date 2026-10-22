# Open a private HON OS reference preview

This setup runs the **existing Next.js application** in your own GitHub Codespace. It does not deploy HON OS, create a database, enable payments or connect AI providers. Start with the existing reference pages; they show illustrative school information, not real school records or operational outcomes.

**Verification status:** configuration and documentation prepared for owner review. No Codespace was created and no browser-accessible URL was launched or tested by Codex. The blocked Codex environment was not used for another dependency-install attempt. A passing repository CI run is not proof that this Codespace or its private forwarding has been tested.

## 1. Check cost and access before creating anything

1. Sign in to [GitHub](https://github.com) with the account that owns or can access `myhonosai/honos`.
2. Open your GitHub account **Settings → Billing & licensing** (sometimes **Billing and plans**), then check **Codespaces** usage, remaining included compute/storage and budgets. Codespaces and GitHub Actions have separate usage accounting. Organization-funded access can have different policies and allowances.
3. Use a blocking/stop-usage budget if your account offers one; an alert-only budget does not prevent charges. If you cannot confirm included capacity or a policy that prevents extra spending, **stop before Create codespace** and obtain the owner's spending approval. Nothing in this PR purchases capacity or guarantees free hosting.
4. Do not authorize production repository/account secrets for this Codespace. Do not copy any production `.env`, database URL, OIDC credentials, Stripe keys, AI keys or real customer information into it. No application secret is needed for this reference preview.

## 2. Create the Codespace on the correct branch

Do this initial setup on your Windows computer; afterward you can open the private website on your phone.

1. Open [myhonosai/honos](https://github.com/myhonosai/honos).
2. **Before this PR is merged:** use the branch selector above the file list to choose `codex/codespaces-reference-preview`. Verify that `.devcontainer/devcontainer.json` is visible. Selecting `main` before owner-approved merge will not include this setup. **After merge:** choose `main` instead.
3. Click the green **Code** button, then **Codespaces**. Use **New with options** in its menu to select the branch and smallest available **2-core** machine. If that menu is unavailable, open [the Codespace creation form](https://github.com/codespaces/new) and explicitly choose this repository and branch. These links are GitHub setup pages, not a live HON preview.
4. Check the selected billing owner, machine and any cost notice. Do not enable paid prebuilds. Click **Create codespace** only after the cost check in step 1.
5. Wait for the browser-based VS Code editor to open and container setup to finish. The guide should open automatically. The container uses Node.js **22**, installs the **pnpm 10.18.0** shim, and does **not** install app dependencies, start servers or execute migrations automatically.
6. In the Codespaces menu, set a short idle timeout, such as 15 minutes. See [GitHub's timeout guide](https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces).

## 3. Check Private visibility before starting HON

1. In VS Code, open the bottom **Ports** tab. If hidden, use **View → Open View… → Ports**.
2. Find port **3000** labeled **HON reference preview - keep Private**. If it is not listed, click **Add Port** and enter `3000`.
3. Right-click it, choose **Port Visibility → Private**, and verify the **Visibility** column says **Private**. Do not choose **Public** or **Private to Organization**; those broaden access beyond the Codespace creator.
4. GitHub defaults new forwarded ports to Private. The devcontainer forwards only 3000 and ignores automatic forwarding of all other ports. The standard devcontainer schema has no `visibility` setting, so this UI check is required, including for reused Codespaces. Labels do not enforce access. If organization policy prevents owner-only Private access, stop.

The public-facing forwarded address uses **HTTPS** with GitHub authentication even though the internal Node server uses HTTP. Keep the port's **protocol** set to HTTP; selecting HTTPS there would expect TLS from the internal server. Do not open port 3001 or a database port.

## 4. Install and build once

Open **Terminal → New Terminal**. It should be at the repository root, normally `/workspaces/honos`. Run each line separately and wait for it to finish successfully before continuing:

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm prepare:workspace
pnpm --filter @hon/web build
```

Expected versions: Node starts with `v22.` and pnpm is exactly `10.18.0`. `prepare:workspace` compiles the existing local packages used by Next.js; it does not run a database migration or start the API. The frozen install uses the existing lockfile. Do not change it to make a failed install pass.

If the tool setup was interrupted, the same non-root initialization command used by the devcontainer is:

```bash
corepack enable --install-directory /usr/local/share/npm-global/bin
corepack prepare pnpm@10.18.0 --activate
```

Stop on an install/build/setup error and report its first useful message, with secret values removed. Do not disable TLS/signature checks, repeatedly retry a broken proxy, upgrade dependencies or paste `.env` contents. An existing Codespace created before this configuration may need **Command Palette → Codespaces: Rebuild Container**, after preserving any local edits.

## 5. Start the website

Once the build succeeds, run:

```bash
env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 NEXT_TELEMETRY_DISABLED=1 HON_API_BASE_URL=http://127.0.0.1:3001 pnpm --filter @hon/web exec next start --hostname 127.0.0.1 --port 3000
```

This runs the real production-built Next.js app on loopback in a deliberately minimal process environment. It is still a **development review**, not a production deployment. Port 3001 has no service in this first stage; authenticated/data-backed modules must remain unavailable. Do not create `.env` files: Next.js can load them even when the shell environment is cleared.

Leave that terminal running. No server starts automatically on container creation, restart or attach. If you see `EADDRINUSE`, stop the earlier preview terminal with **Ctrl+C** rather than running another copy. After ordinary restarts, repeat only the start command; reinstall/rebuild only if dependencies/source changed or the previous build did not complete.

Optional local server check from a **second** terminal:

```bash
curl --fail --silent --output /dev/null --write-out 'HTTP %{http_code}\n' http://127.0.0.1:3000/
```

A local HTTP 200 verifies a response, not the external privacy boundary, images, JavaScript or accessibility.

## 6. Open it on Windows and your phone

1. Return to **Ports**, confirm **3000 → Private** again, then click its **Open in Browser** globe icon.
2. A new tab opens the literal HTTPS forwarding URL assigned to your Codespace. GitHub may ask you to sign in. **That URL is your preview address**; copy the actual value from GitHub rather than inventing one from a sample.
3. On your phone, sign in to the **same GitHub account**, open the copied URL and keep the Codespace running. GitHub owner authentication remains required; sending someone the link does not give them access.
4. To open the pages below, keep the same HTTPS origin and replace only its path. For example, append `/core` to the copied base address.

| Path | What you can inspect without school login |
| --- | --- |
| `/` | Existing HON Complete reference dashboard, illustrative AI roster, appearance controls and HON presentation |
| `/core` | Existing Core reference dashboard and conventional-operation design |
| `/complete-mobile` | Existing touch-first/Big Button reference |
| `/pricing` | Core/Complete planning and pricing reference; no purchase or charge |

Reference switches and navigation are real frontend interactions; sample metrics, activity labels and school identities are illustrative. Follow only these reference paths for this stage. Links into `/staff/*`, `/hq/*`, `/parent/*` or subscription screens may redirect to sign-in, show an unconfigured-auth response, or require unavailable authorized APIs. This is expected and must not be “fixed” by disabling security.

**Known asset limit:** 22 legacy `/manus-storage/...` image references are absent from this checkout's public assets. Some school reference portraits/logo may show fallback initials or missing images outside the original host. HQ's local approved image sheets/background and `/ai` assets remain untouched. This PR does not remap or replace artwork. Three appearance modes are available only where already implemented; this setup does not add mode parity or translation coverage.

## 7. Verify access and usability

Before calling this preview verified:

- In a signed-in desktop browser, open all four reference paths and try their existing navigation/appearance controls. On mobile, check touch targets, scrolling, wrapping and any horizontal overflow; use keyboard Tab/Enter on desktop.
- Check developer tools for errors and failed assets. Distinguish the known legacy asset paths from new failures. Nothing in this configuration proves those runtime checks passed.
- Copy the HTTPS address into a signed-out/private browser window. It must require GitHub authentication and must **not** display HON without the owner's access. If it does, stop the server immediately and correct port visibility before proceeding. Do not authenticate the signed-out window during this check.
- Confirm no API/database service was started, no production configuration was added, and no real business information is displayed. Reference pages do not establish real enrollment, payment, AI activity or provider connectivity.

## 8. Additional HQ, school and CRM screens: existing fixtures and boundaries

The reference start command intentionally does **not** unlock protected pages. Enabling an interactive owner demo of them requires a separate reviewed preview-only launcher; it is **not implemented by this PR**. Do not issue a broadly privileged session, add a login-bypass route, use a query-string role, expose JWTs or paste test cookies into a public URL.

Existing reusable verification mechanisms are:

| Mechanism | Existing supported coverage | How it is currently run |
| --- | --- | --- |
| `apps/web/scripts/hq-browser-verification.mjs` and `scripts/fixtures/hq-*` | HQ overview, directory, Champions rankings/statistics/ledger, subscription/invoice evidence; synthetic localhost responders, isolated signed subjects | Temporary HQ browser workflow or its explicit `HON_HQ_BROWSER_LOCAL=1` opt-in; requires pinned Playwright/axe tools, Chrome and results paths. Its current workflow has a historical branch gate; this PR does not change it. |
| `apps/web/scripts/crm-adult-flow-browser.mjs`, `crm-family-browser.mjs`, `crm-close-browser.mjs` | Adult/family registration, guardian payer, per-child plan DRAFT, recovery, catalog, privacy shield and exact retries | `Connected Adult CRM Browser` workflow with ephemeral signed test sessions and local fixtures. The top-level runner requires `GITHUB_ACTIONS=true`; do not impersonate CI in a Codespace to bypass that guard. |
| `apps/web/scripts/school-subscription-browser.mjs`, `scripts/fixtures/school-checkout.mjs`, `localization-browser.mjs` | School purchase/readiness/invoices and language scenarios using deterministic fixtures | Existing school-subscription workflow or documented script opt-in `HON_SUBSCRIPTION_LOCAL=1`, with pinned tools and a production web build. Simulated provider/payment evidence is not a Stripe sandbox run. |
| `apps/web/scripts/crm-recovery-api-verification.mjs`, `crm-family-api-verification.mjs` | Real frontend transports through signed-session Nest API into guarded disposable PostgreSQL | Existing CRM CI job, whose setup explicitly creates localhost-only disposable databases. This is separate from synthetic browser testing and is not part of the reference preview setup. |

These harnesses inject test sessions into isolated automated browser contexts and exit after their checks. They are **not** a persistent interactive sign-in or a phone-accessible fixture server. See the corresponding workflow files for exact tool versions, environment variable names and opt-ins. Do not set fake CI flags, expose their signing secrets, modify guards or forward their API port as a shortcut.

A future narrowly scoped launcher can reuse these closed fixtures and real `@hon/auth` signing/verification while remaining outside production routes. It must:

1. Stay behind owner-only GitHub Private forwarding and keep fixture/API services on loopback and unforwarded. Use a clearly visible synthetic-data label throughout.
2. Use only ephemeral preview-specific signing material. Keep HQ, school staff and parent identities isolated. Explicit role switches must replace the scoped session and clear all old facts/retries; a school or family never gains HQ authority.
3. Allow-list supported synthetic endpoints, refuse everything else locally and never forward unmatched requests to production, Stripe, AI, ads or messaging. Never claim fixture actions are real transactions.
4. Preserve normal page authentication, exact-school/family checks, direct-human permissions, entitlements, stale-response guards and retry behavior. No changes to shared auth, RLS, runtime grants or database contracts are needed for a browser fixture.
5. Add separately authorized parent/scheduling fixtures only for real existing contracts. Do not imply that current HQ/CRM fixtures cover every staff or family screen.
6. Pass authenticated/anonymous/cross-role/cross-school checks, private-gateway denial, desktop/mobile/browser/keyboard/accessibility checks before an owner demo is called verified.

No such authenticated preview launcher or additional API behavior is added here. Real API/database tests remain confined to disposable CI fixtures, never a persistent/production database.

## 9. Stop safely and control costs

- **Ctrl+C** stops Next.js, but not the Codespace compute. At [github.com/codespaces](https://github.com/codespaces), open the Codespace's **… → Stop codespace**, or use **Command Palette → Codespaces: Stop Current Codespace**.
- Closing the browser tab alone does not stop compute immediately. Idle timeout is a fallback, not a spending guarantee.
- Stopped Codespaces can continue consuming storage allowance. When the review is finished, preserve any intended Git changes first, then **Delete** the disposable Codespace from that dashboard. This removes its local files, not the GitHub repository or its branch.
- Retain only the smallest needed machine and one Codespace. No prebuilds, paid integrations, live data, new hosting accounts or external deployment are configured here. Check actual current GitHub pricing/usage rather than assuming included quota or a dollar rate.

## Changes and scope

Only `.devcontainer/devcontainer.json`, this guide and a narrow TODO entry are changed. Application routes, original assets, authentication, database migrations, billing/entitlements/payments, CI workflows and PRs #27/#17/#3 are unchanged. No Codespace, paid service, external host or production environment was provisioned. Owner review and approval are required before merging this setup.
