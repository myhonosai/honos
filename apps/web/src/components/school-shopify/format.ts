/** Formatting and links shared by the Commerce Workspace views. */
export function money(locale: string, currency: string | null, amount: number): string {
  try { return new Intl.NumberFormat(locale, currency ? { style: 'currency', currency } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount); }
  catch { return amount.toFixed(2); }
}

const handleOf = (domain: string) => domain.replace(/\.myshopify\.com$/, '');
/** Shopify admin links: built only from the verified myshopify name and numeric ids. */
export function shopifyAdminUrl(domain: string, kind: 'home' | 'products' | 'orders', id?: string): string {
  const base = `https://admin.shopify.com/store/${encodeURIComponent(handleOf(domain))}`;
  return kind === 'home' ? base : `${base}/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`;
}
