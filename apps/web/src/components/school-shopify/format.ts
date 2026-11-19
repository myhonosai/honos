/** Formatting and links shared by the Commerce Workspace views. */
export function money(locale: string, currency: string | null, amount: number): string {
  try { return new Intl.NumberFormat(locale, currency ? { style: 'currency', currency } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount); }
  catch { return amount.toFixed(2); }
}

const handleOf = (domain: string) => domain.replace(/\.myshopify\.com$/, '');
/** The Shopify admin pages HON links to, by their admin path (checked against the live admin, 2026-11-19). */
export const SHOPIFY_ADMIN_PAGES = { home: '', orders: 'orders', products: 'products', customers: 'customers', discounts: 'discounts',
  analytics: 'analytics', finance: 'finance', credit: 'credit', themes: 'themes', settings: 'settings' } as const;
export type ShopifyAdminPage = keyof typeof SHOPIFY_ADMIN_PAGES;
/** Shopify admin links: built only from the verified myshopify name, a fixed page and numeric ids. */
export function shopifyAdminUrl(domain: string, kind: ShopifyAdminPage, id?: string): string {
  const base = `https://admin.shopify.com/store/${encodeURIComponent(handleOf(domain))}`, path = SHOPIFY_ADMIN_PAGES[kind];
  return path === '' ? base : `${base}/${path}${id ? `/${encodeURIComponent(id)}` : ''}`;
}
