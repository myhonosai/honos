# HON Family (mobile)

Native family app for HON OS: React Native + Expo + TypeScript. Plan, gap matrix, screen map, API plan and Eian
authority map: [`docs/architecture/PARENT_MOBILE_APP.md`](../../docs/architecture/PARENT_MOBILE_APP.md).
Store builds: [`STORE_BUILDS.md`](STORE_BUILDS.md).

- Own `package-lock.json`; excluded from the pnpm workspace so the main CI never installs React Native. Use npm.
- Reads the shared response verifiers from `packages/contracts/src` (Metro + Jest map `@hon/contracts/*`).
  The app never keeps its own copy of a contract.
- Authority comes only from the signed session and the server's live family resolver. The app never sends a
  family, school or child id as authority and never shows unverified or stale family data as current.

```
npm ci
npm test            # Jest + Testing Library
npm run check       # TypeScript
npm run bundle:check  # iOS + Android JS bundles (needs EXPO_PUBLIC_HON_API_URL)
EXPO_PUBLIC_HON_API_URL=http://localhost:4000 npm start
```
