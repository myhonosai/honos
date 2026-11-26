import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BLAST_COPY } from '../src/components/school-blasts/copy';
import { checkoutPageLink, insertLink, liveCheckoutLinks, newBlastDraft } from '../src/components/school-blasts/format';
import { SchoolBlastsView, type SchoolBlastsViewProps } from '../src/components/school-blasts/view';
import { id } from './account-status-fixtures';

// BL2: a Live checkout page's share link (0620) goes into an email or a text as a plain link where the cursor is.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const A = id(51), B = id(52), C = id(53), PA = 'a1'.repeat(24), PB = 'b2'.repeat(24), PC = 'c3'.repeat(24);
const draft = (channel: 'EMAIL' | 'SMS' = 'EMAIL') => ({ ...newBlastDraft(channel), name: 'Open house', subject: channel === 'EMAIL' ? 'Hi' : '', body: 'Join us' });
function props(over: Partial<SchoolBlastsViewProps> = {}): SchoolBlastsViewProps {
  return { language: 'en', waiting: false, concealed: false, hasSchool: true, list: { state: 'READY', blasts: [] }, selected: null, draft: draft(),
    dirty: true, problems: [], preview: null, scheduleLocal: '', scheduleValid: false, ask: null, outcome: null, locked: false, canRetry: false,
    pictures: { state: 'READY', assets: [] }, checkouts: { state: 'READY', pages: [{ pageId: A, publicId: PA, title: 'Summer camp' }] }, checkoutPickerOpen: false, ...over };
}
const page = (pageId: string, status: string, title: Record<string, string>) => ({ pageId, status, content: { title } }) as never;

it('lists only Live pages that have a link, in the given order, titled in the staff language', () => {
  const read = { pages: [page(A, 'PUBLISHED', { en: 'Summer camp', ko: '여름 캠프' }), page(B, 'DRAFT', { en: 'Draft' }), page(C, 'PUBLISHED', { en: 'Trial week' })] };
  const issued = { links: [{ pageId: C, publicId: PC }, { pageId: A, publicId: PA }, { pageId: B, publicId: PB }] };
  expect(liveCheckoutLinks(read, issued, 'en')).toEqual([{ pageId: A, publicId: PA, title: 'Summer camp' }, { pageId: C, publicId: PC, title: 'Trial week' }]);
  expect(liveCheckoutLinks(read, issued, 'ko').map(l => l.title)).toEqual(['여름 캠프', 'Trial week']);
  expect(liveCheckoutLinks(read, { links: [{ pageId: C, publicId: PC }] }, 'es').map(l => l.pageId)).toEqual([C]);
});

it('the link is the checkout page share address and goes in where the cursor is', () => {
  const url = checkoutPageLink('https://app.example.test/', PA);
  expect(url).toBe(`https://app.example.test/checkout/${PA}`);
  expect(insertLink('Join us', 4, 4, url).text).toBe(`Join ${url} us`);
  for (const c of Object.values(BLAST_COPY)) {
    for (const key of ['checkoutTitle', 'insertCheckoutLink', 'checkoutHint', 'noCheckouts', 'checkoutsDenied', 'checkoutsUnavailable'] as const) expect(c[key]).toBeTruthy();
  }
});

it('emails and texts both offer the checkout picker; it shows Live pages, or says why there are none', () => {
  const closed = renderToStaticMarkup(<SchoolBlastsView {...props()} />);
  expect(closed).toContain('data-testid="blast-checkouts"'); expect(closed).toContain('Insert checkout link<'); expect(closed).not.toContain('data-testid="blast-checkout-picker"');
  for (const channel of ['EMAIL', 'SMS'] as const) {
    const open = renderToStaticMarkup(<SchoolBlastsView {...props({ draft: draft(channel), checkoutPickerOpen: true })} />);
    expect(open).toContain(`data-pick-checkout="${A}"`); expect(open).toContain('Summer camp');
  }
  expect(renderToStaticMarkup(<SchoolBlastsView {...props({ checkoutPickerOpen: true, checkouts: { state: 'READY', pages: [] } })} />)).toContain('No Live checkout pages yet');
  expect(renderToStaticMarkup(<SchoolBlastsView {...props({ checkoutPickerOpen: true, checkouts: { state: 'DENIED' } })} />)).toContain('access to Checkout pages');
  expect(renderToStaticMarkup(<SchoolBlastsView {...props({ checkoutPickerOpen: true, checkouts: { state: 'UNAVAILABLE' } })} />)).toContain('could not be read');
  expect(renderToStaticMarkup(<SchoolBlastsView {...props({ draft: null })} />)).not.toContain('data-testid="blast-checkouts"');
});
