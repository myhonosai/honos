# HON Family — store build hand-off (for Manus)

Owner rule: **no store submission, no paid account, no EAS plan purchase and no production API address without
David's explicit OK.** Claude writes the app; Manus runs the builds and submissions from David's Apple and Google
developer accounts once he approves each step.

## What is ready
- Expo SDK 58 app in `apps/parent-mobile` (React Native 0.88, TypeScript), own `package-lock.json`.
  It is deliberately **outside** the pnpm workspace (`pnpm-workspace.yaml` excludes it). Use `npm`, not `pnpm`.
- `eas.json` with `development`, `preview` (internal distribution) and `production` profiles.
- `app.json`: name "HON Family", iOS bundle id and Android package `com.myhonos.family` (David, 2026-11-17).
- `eas.json`: `preview` and `production` use the live site, API `https://app.myhonos.com/api` (the web's `/api/v1`
  proxy) and web `https://app.myhonos.com` (David, 2026-11-17: test builds use the live site). `development` stays local.

## Decided by David (2026-11-17)
- Bundle id / package: `com.myhonos.family`. Store name: **HON Family**.
- Test and store builds point at the live site, app.myhonos.com. Test builds therefore show real families' data to
  whoever signs in: only install them for people who are themselves guardians at a school, signing in as themselves.

## Still needed before the first upload
1. Seller name, support URL, privacy policy URL.
2. Expo account/organization that owns the project (`eas init` writes `extra.eas.projectId` into `app.json`).
3. The live web deploy must include the mobile sign-in routes (#465) and the `mobile` login intent (pending the web
   sign-in PR); until both are deployed, a build opens to sign-in but cannot finish it.
4. Before a store release: a claimed https return address (Universal Links / App Links) replaces `honparent://`.

## Steps (each needs David's go-ahead)
1. `cd apps/parent-mobile && npm ci`
2. `npx eas-cli login` with the Expo account David chooses, then `npx eas-cli init` (commit the projectId change in a PR).
3. Internal test builds: `npx eas-cli build --profile preview --platform all`. EAS uploads the git repository so the
   shared `packages/contracts` sources are included; run the command from `apps/parent-mobile`.
4. Credentials: let EAS manage iOS certificates/profiles and the Android keystore, signed in with David's accounts.
   Never commit `.p8`, `.p12`, `.jks`, `.mobileprovision` or service-account JSON (they are git-ignored).
5. Store: `npx eas-cli build --profile production` then `npx eas-cli submit` **only after David approves the release.**
   First Apple submission needs the App Privacy questionnaire (children's data: the user is the adult guardian;
   no tracking, no ads) and a demo account for review. Ask Claude for a review account on a test school; never use
   a real family.

## Verify before handing a build to anyone
- `npm test`, `npm run check`, `npm run bundle:check` all pass (the "Parent mobile app" GitHub workflow runs these).
- The build opens to "Sign in to your school". Mobile sign-in is milestone M2 (see
  `docs/architecture/PARENT_MOBILE_APP.md`); until it merges, a build cannot show any family data.

## Branded school apps (later, M7)
Same code, one `app.config` per school selected at build time (name, icon, colors, bundle id). Apple's 4.3 spam
rule limits near-identical listings, so branded apps need David's commercial decision and a per-school review plan
before any are built.
