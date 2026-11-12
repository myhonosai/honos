# HON OS marketing website (`@hon/website`)

A static, single-page marketing site for HON OS. Plain HTML, CSS and JavaScript with no runtime dependencies. See [SPEC.md](SPEC.md) for scope and the rules on what the page may claim.

```sh
pnpm --filter @hon/website test      # content, link and build rules
pnpm --filter @hon/website build     # writes apps/website/dist
pnpm --filter @hon/website preview   # build, then serve dist on http://localhost:4173
```

Build settings:

| Variable | Default | Meaning |
|---|---|---|
| `HON_WEBSITE_APP_URL` | `http://localhost:3000` | Origin of the HON OS app. "Start a new school" goes to `<origin>/account/start`, "Sign in" to `<origin>/auth/login`. Only a plain http(s) origin is accepted. |
| `HON_WEBSITE_INDEXABLE` | unset | Set to `1` only once David approves the site going live. Otherwise every build is `noindex, nofollow`. |

Editing copy: the source of truth is the project's website summary (`HON_OS_WEBSITE_SUMMARY.md`). Anything not built on `main` stays marked "soon" or "coming soon"; the tests in `test/content.test.mjs` hold the list of things the page must never say.

Hosting is not set up. When David approves, a Render static site would use build command `pnpm install --frozen-lockfile && pnpm --filter @hon/website build` and publish directory `apps/website/dist`. `render.yaml` is intentionally unchanged.
