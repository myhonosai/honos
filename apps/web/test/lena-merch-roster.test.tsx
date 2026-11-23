import { expect, it } from 'vitest';
import { HON_COMMAND_ROSTER } from '../src/components/hon-command/roster';

// P6: merchandise ideas and the store presentation review already run (0596 Shopify merch ideas, 0615 commerce review) as
// Marcus. Lena's card now links to them truthfully instead of saying Backend required, and Marcus's card lists them too.
it('links Lena and Marcus to the Shopify Merch Studio, says Marcus writes the drafts, and adds no new AI ability', () => {
  const lena = HON_COMMAND_ROSTER.find((a) => a.id === 'lena')!, marcus = HON_COMMAND_ROSTER.find((a) => a.id === 'marcus')!;
  const lenaMerch = lena.capabilities.find((c) => /Merchandise/.test(c.label))!;
  expect(lenaMerch).toMatchObject({ state: 'AVAILABLE', href: '/staff/billing/shopify' });
  expect(lenaMerch.label).toMatch(/Marcus writes these/);
  expect(lena.capabilities.filter((c) => c.state === 'BACKEND_REQUIRED')).toEqual([]);
  expect(marcus.capabilities.find((c) => /Merchandise/.test(c.label))).toMatchObject({ state: 'AVAILABLE', href: '/staff/billing/shopify' });
  expect(marcus.capabilities.find((c) => c.label === 'Publish, advertise or spend')?.state).toBe('BACKEND_REQUIRED');
});
