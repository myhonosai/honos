# Parent pro shop (0581)

Owner ask (2026-11-19): "proshop as well like shopify items?"

## What it does

- In the HON Family app, **More > Pro shop** lists the school's own Shopify products that HON already mirrors (0405/0449):
  title, image and the lowest price, sorted by title, at most 100.
- Tapping an item opens that product on the school's own store (`https://<shop>.myshopify.com/products/<handle>`) in the
  in-app browser. **Buying happens there.** HON takes no order, payment or customer detail and is never the merchant.
- The sample family shows two made-up items that never open a real store.

## Rules

| Rule | Detail |
| --- | --- |
| Who | A family with exactly one live grant at the school (any access level). No school or family selector is accepted. |
| Which store | Only a `CONNECTED` connection. A store that needs reconnecting or was disconnected is not shown, even though its rows stay until cleanup. |
| Which products | `ACTIVE`, not removed, a handle of lowercase letters, digits and dashes, and at least one live variant. The price is the lowest live variant price. |
| Never shown | Vendor, product type, SKU, barcode, unit cost, margin, inventory and orders. |
| Link | Built from the current synced row on every read and never stored. The contract accepts only one `*.myshopify.com` host per answer and Shopify CDN images. |
| Database | `hon.read_parent_pro_shop(text)` (SECURITY DEFINER, runtime EXECUTE only, no DML) and the private `hon.parent_pro_shop_scope(text)`. Names avoid the reserved `shopify_` prefix, so the Shopify proofs' runtime allowlists are unchanged. |
| API | `GET /v1/parent/pro-shop` (`parent.pro_shop.read`). |

## Known limits

- `ACTIVE` mirrors Shopify's product status, not whether the product is published to the Online Store channel, so a listed
  item can occasionally open a "not found" page. Syncing publication would be a change to the Shopify sync (the Shopify
  thread offered to add it).
- A password-protected store (such as a development store) shows Shopify's password page.

## Evidence

- `packages/database/scripts/test-parent-pro-shop-integrity.mjs` (signed HTTP on the disposable CRM-close fixture).
- `infra/postgres/011_verify_supabase_hon_runtime.sql` section "Parent pro shop exact verification (0581)".
- `apps/api/test/parent-pro-shop.test.cjs`, `apps/parent-mobile/test/pro-shop-ui.test.tsx`.

Not deployed. Deploys together with the rest of the HON Family work on the owner's OK.
