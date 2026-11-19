import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { shopifyText } from '../src/components/school-shopify/copy';
import { SHOPIFY_SECTIONS } from '../src/components/school-shopify/view';

const ctx = () => ({ t: (k: Parameters<typeof shopifyText>[1], v?: Record<string, string>) => shopifyText('en', k, v), locale: 'en-US', domain: 'ima-test.myshopify.com', currency: 'USD' });

it('the Shopify admin section opens each real admin page in a new tab, on this store only', async () => {
  const { AdminLinks } = await import('../src/components/school-shopify/view');
  const { shopifyAdminUrl } = await import('../src/components/school-shopify/format');
  expect(SHOPIFY_SECTIONS).toContain('admin');
  const html = renderToStaticMarkup(<AdminLinks ctx={ctx()} />);
  for (const [k, path] of [['home', ''], ['orders', '/orders'], ['finance', '/finance'], ['credit', '/credit'], ['themes', '/themes'], ['settings', '/settings']] as const)
    expect(html).toContain(`href="https://admin.shopify.com/store/ima-test${path}" target="_blank" rel="noopener noreferrer" data-admin-link="${k}"`);
  expect(html.match(/data-admin-link=/g)).toHaveLength(10);
  expect(html).toContain('Finance and payouts');
  expect(shopifyAdminUrl('ima-test.myshopify.com', 'orders', '123')).toBe('https://admin.shopify.com/store/ima-test/orders/123');
});
