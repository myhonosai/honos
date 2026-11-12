# Hosting the HON OS website (prepared, not applied)

Nothing here is deployed. Creating the service is a deploy and needs David's explicit OK. The block below is deliberately **not** in `render.yaml`: with Blueprint Auto Sync on, adding it to `main` would create the site straight away (see the header of `render.yaml`).

## What David decides first

1. The site's domain (for example `honos.ai` or `www.…`), and the app's public address that "Start a new school" and "Sign in" should open (`HON_WEBSITE_APP_URL`).
2. Whether to go live indexable (`HON_WEBSITE_INDEXABLE=1`) or keep a hidden preview first (leave it unset).
3. OK to create the Render static site (check Render's current static-site pricing on the workspace plan).

## Render static site

Add to `render.yaml` under `services:` only with that OK, then turn Auto Sync back off as `docs/operations/RENDER_DEPLOYMENT.md` describes:

```yaml
  - type: web
    name: hon-website
    runtime: static
    branch: main
    autoDeployTrigger: off
    buildCommand: >-
      corepack enable && corepack prepare pnpm@10.18.0 --activate &&
      pnpm install --frozen-lockfile &&
      pnpm --filter @hon/website test &&
      pnpm --filter @hon/website build
    staticPublishPath: apps/website/dist
    envVars:
      - key: NODE_VERSION
        value: 22.23.4
      - key: HON_WEBSITE_APP_URL
        sync: false          # the app's public origin, e.g. https://app.<domain>
      - key: HON_WEBSITE_INDEXABLE
        sync: false          # "1" only when David approves going live
    headers:
      - path: /*
        name: Content-Security-Policy
        value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'"
      - path: /*
        name: X-Content-Type-Options
        value: nosniff
      - path: /*
        name: Referrer-Policy
        value: strict-origin-when-cross-origin
      - path: /fonts/*
        name: Cache-Control
        value: public, max-age=31536000, immutable
      - path: /assets/*
        name: Cache-Control
        value: public, max-age=86400
```

Checked locally: all three language pages render with this Content-Security-Policy and show no CSP errors (2026-11-12).

## After it is created

- Add the custom domain in Render and the DNS records it shows. Render issues the TLS certificate.
- Open `/`, `/ko/` and `/es/`, and click "Start a new school" to confirm it reaches the app's `/account/start`.
- Before setting `HON_WEBSITE_INDEXABLE=1`: native-speaker read of the Korean and Spanish copy, and privacy and terms pages.
