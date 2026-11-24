/**
 * Parent pro shop (0581). The family's school's own Shopify products that HON mirrors, each with a link to its page on the
 * school's store. Buying happens on that page: HON takes no order, payment or customer detail. Inventory, cost and orders
 * never reach a family.
 */
export interface ParentProShopProduct { productId: string; title: string; imageUrl: string | null; fromPrice: string; url: string }
export interface ParentProShop { schoolName: string; available: boolean; currency: string | null; products: ParentProShopProduct[] }
export const PARENT_PRO_SHOP_LIMIT = 100;

const SHOP_URL = /^https:\/\/[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com\/products\/[a-z0-9][a-z0-9-]{0,254}$/;
const IMAGE_URL = /^https:\/\/[a-z0-9.-]+\.(shopify\.com|shopifycdn\.net)\/[^\s"'<>\\]*$/;
const PRICE = /^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid pro shop data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) invalid();
  return value;
}
function product(value: unknown): ParentProShopProduct {
  const row = record(value, ['productId', 'title', 'imageUrl', 'fromPrice', 'url']);
  if (typeof row.productId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.productId)) invalid();
  if (row.imageUrl !== null && (typeof row.imageUrl !== 'string' || row.imageUrl.length > 2048 || !IMAGE_URL.test(row.imageUrl))) invalid();
  if (typeof row.fromPrice !== 'string' || !PRICE.test(row.fromPrice)) invalid();
  if (typeof row.url !== 'string' || !SHOP_URL.test(row.url)) invalid();
  return { productId: row.productId, title: text(row.title, 255), imageUrl: row.imageUrl as string | null, fromPrice: row.fromPrice, url: row.url };
}
export function verifyParentProShop(value: unknown): ParentProShop {
  const row = record(value, ['schoolName', 'available', 'currency', 'products']);
  if (typeof row.available !== 'boolean' || !Array.isArray(row.products) || row.products.length > PARENT_PRO_SHOP_LIMIT) invalid();
  if (row.available ? (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) : (row.currency !== null || row.products.length !== 0)) invalid();
  const products = row.products.map(product);
  if (new Set(products.map(p => p.productId)).size !== products.length) invalid();
  const hosts = new Set(products.map(p => p.url.slice(8, p.url.indexOf('/', 8))));
  if (hosts.size > 1) invalid();
  return { schoolName: text(row.schoolName, 200), available: row.available, currency: row.currency as string | null, products };
}
