# HON Parent — store build hand-off (for Manus)

Owner rule: **no store submission, no paid account, no EAS plan purchase and no production API address without
David's explicit OK.** Claude writes the app; Manus runs the builds and submissions from David's Apple and Google
developer accounts once he approves each step.

## What is ready
- Expo SDK 58 app in `apps/parent-mobile` (React Native 0.88, TypeScript), own `package-lock.json`.
  It is deliberately **outside** the pnpm workspace (`pnpm-workspace.yaml` excludes it). Use `npm`, not `pnpm`.
- `eas.json` with `development`, `preview` (internal distribution) and `production` profiles.
- `app.json`: name "HON Parent", iOS bundle id and Android package `com.myhonos.parent`.

## Decisions David must confirm before the first upload (cannot be changed after publishing)
1. Bundle id / package name (`com.myhonos.parent` is a proposal).
2. Store listing name ("HON Parent"?), seller name, support URL, privacy policy URL.
3. Which API and web addresses each profile uses (`EXPO_PUBLIC_HON_API_URL` and `EXPO_PUBLIC_HON_WEB_URL`
   placeholders in `eas.json`; a build with a `REPLACE-WITH` placeholder refuses to start).
4. Expo account/organization that owns the project (`eas init` writes `extra.eas.projectId` into `app.json`).

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
