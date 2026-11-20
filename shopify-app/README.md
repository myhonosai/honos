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

1. Install the Shopify CLI (`npm install -g @shopify/cli`) and sign in to the Partner account that owns HON OS.
2. In this folder run `shopify app config link` and choose the HON OS app. This fills in `client_id`.
3. Optional, with a development store: `shopify app dev` and check the blocks in that store's theme editor.
4. Run `shopify app deploy` and confirm. This creates and releases an app version that contains the extension.
5. Shopify's network access declaration for apps with theme app extensions (required from 2026-12-01 for public apps)
   is answered in the Partner Dashboard: this extension makes **no network requests**.

HON's API needs the same Client ID as `SHOPIFY_API_KEY` to build the theme editor links; nothing else changes on HON's side.
