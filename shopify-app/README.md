# HON OS Shopify app (theme app extension)

This folder holds only what the Shopify CLI needs to release **HON's storefront blocks** (TB2) as a
[theme app extension](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions). It replaces TB1, which
asked for `write_themes`; Shopify declined that scope and recommended theme app extensions instead.

## What the extension is

`extensions/hon-storefront/`:

| File | Kind | Where it shows |
| --- | --- | --- |
| `blocks/school-colors.liquid` | App embed (head) | Every page: buttons and accents in the school's colors |
| `blocks/size-guide.liquid` | App block | Product pages: a collapsible size guide |
| `blocks/pickup-note.liquid` | App block | Cart page (themes whose cart takes app blocks) |
| `blocks/pickup-note-banner.liquid` | App embed (body) | Cart page banner, for themes whose cart does not take app blocks |

All four read one app-data metafield HON writes on its own app installation (`hon_storefront.settings`, JSON). HON
writes it with `metafieldsSet` when a school owner presses **Publish** in HON (Shopify, Storefront). That needs no
access scope, and HON never reads or writes theme files. Every value is escaped, and colors are re-checked as `#RRGGBB`
in Liquid before they reach CSS.

The owner adds the blocks with the links HON shows (Shopify theme editor deep links), previews them and presses Save in
Shopify. Removing a block in the theme editor undoes it.

## Releasing it (owner step, not automated)

Releasing an app version is a change to the live app, so it is done by the app owner, not by HON's agents or CI.

1. Install the Shopify CLI (`npm install -g @shopify/cli`). On Windows PowerShell use `shopify.cmd` in place of
   `shopify`, because PowerShell blocks the `.ps1` launcher.
2. In this folder run `shopify app config link`, sign in to the organization that owns HON OS and choose the HON OS
   app. The CLI rewrites `shopify.app.toml` from the live app and drops the `[build]` line; put
   `include_config_on_deploy = true` back (see the comment in that file for why `false` is dangerous).
3. Optional, with a development store: `shopify app dev` and check the blocks in that store's theme editor.
4. Run `shopify app deploy --no-release`. Read the summary before confirming. The only acceptable changes are the
   extension line (`+ hon-storefront (new)` or `(updated)`) and, at most, `access_scopes (updated)` when the scope
   list is only re-ordered. Cancel if any configuration item shows `(removed)`.
5. Open the new version in the Dev Dashboard (Versions) and compare it with the active version: name, URLs, scopes,
   install flow, redirect URLs and webhook version must be the same.
6. Release it: `shopify app release --version=<name>`, or the Release button on that version's page.
7. Shopify's network access declaration for apps with theme app extensions (required from 2026-12-01 for public apps)
   is answered in the dashboard: this extension makes **no network requests**.

First release: 2026-11-21, version `hon-os-3` (configuration identical to `hon-os-2`, plus the extension).

Next release (prepared, not released): adds the webhook subscriptions and the optional scopes
`read_shopify_payments_accounts` (Allow finance) and `write_orders` (Allow orders: front-desk sales of made-to-order
items create a paid order, migration 0614). Expected summary: `access_scopes (updated)` and `webhooks (updated)`, the extension
unchanged, nothing `(removed)`. Before releasing it, HON's live API must already answer
`POST https://app.myhonos.com/api/v1/commerce/webhooks/shopify` (an unsigned request gets 401), or Shopify will retry
and eventually drop the subscriptions.
Released as `hon-os-4` on 2026-11-21.

Next release (prepared, not released): adds the optional scope `read_shopify_payments_payouts` (Allow finance: the
payouts list). Expected: only `access_scopes` changes; URLs, webhooks and the extension stay as they are.
The `orders/*` topics carry customer data: Shopify needs protected customer data access approved for the app in the
Dev Dashboard (API access requests) first, or the deploy can refuse those subscriptions.
The orders HON creates carry a shipping name and address. The app's protected customer data request covers Level 1
only today; whether creating an order with an address needs the name and address fields approved too is not settled.
Try Allow orders and one front-desk sale on the test store (development stores do not enforce the approval) and check
the request in the Dev Dashboard before any real store uses it.

HON's API needs the same Client ID as `SHOPIFY_API_KEY` to build the theme editor links; nothing else changes on HON's side.
