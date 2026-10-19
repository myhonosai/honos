import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingAccountWorkbench } from '../src/components/billing-account-workbench';

const sourceContactPersonId = '33333333-3333-4333-8333-333333333333';

afterEach(() => vi.restoreAllMocks());

describe('billing account CRM candidate presentation', () => {
  it('renders a valid URL candidate as an inert reference without payer selection, transport, or key allocation', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const allocate = vi.spyOn(crypto, 'randomUUID');
    try {
      const html = renderToStaticMarkup(<BillingAccountWorkbench initialSourceContactPersonId={sourceContactPersonId} />);
      expect(html).toContain('CRM source-contact candidate:'); expect(html).toContain(sourceContactPersonId);
      expect(html).toContain('not a payer selection'); expect(html).toContain('separate explicit lookup');
      expect(html).not.toContain('Selected payer:'); expect(fetcher).not.toHaveBeenCalled(); expect(allocate).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); allocate.mockRestore(); }
  });

  it('rejects malformed candidates and keeps candidate state out of the billing command path', () => {
    const invalid = renderToStaticMarkup(<BillingAccountWorkbench initialSourceContactPersonId="not-a-uuid" />);
    expect(invalid).not.toContain('CRM source-contact candidate:');
    const source = readFileSync('src/components/billing-account-workbench.tsx', 'utf8');
    expect(source).toContain('initialSourceContactPersonId'); expect(source).toContain("resetDraft(true)"); expect(source).toContain("setSourceContactCandidate('')");
    expect(source).not.toMatch(/prepareBillingAccountCommand\([^)]*sourceContactCandidate/);
    expect(source).not.toMatch(/prepareBillingAccountPayerLookup\([^)]*sourceContactCandidate/);
    expect(source).not.toMatch(/responsiblePersonId:\s*sourceContactCandidate/);
  });
});
