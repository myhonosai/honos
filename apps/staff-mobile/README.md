# HON Staff app (`apps/staff-mobile`)

The staff phone app where HON, Kai and the AI team will live. Plan: `/mnt/project-files/staff-app/STAFF_APP_PLAN.md`;
sign-in spec: `docs/architecture/STAFF_MOBILE_SIGN_IN.md`.

- React Native + Expo + TypeScript, same stack as `apps/parent-mobile`. Outside the pnpm workspace with its own npm
  lockfile; shared response verifiers are read from `packages/contracts/src` (Metro/Jest alias).
- S0b (this version): sign in, find or choose the school you work at, signed-in home. Nothing else yet.
- `npm ci`, `npm test`, `npm run check`, `npm run bundle:check` (CI: `.github/workflows/staff-mobile.yml`).
- Build env: `EXPO_PUBLIC_HON_API_URL`, `EXPO_PUBLIC_HON_WEB_URL` (see `eas.json`). No EAS project is linked yet; no
  build or store submission without the owner's go-ahead.
