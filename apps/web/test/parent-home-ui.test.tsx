import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { ParentHome, ParentHomeCards, type ParentHomeReadState } from '../src/components/parent-home';

const ready: ParentHomeReadState = { kind: 'ready' };
const unavailable: ParentHomeReadState = { kind: 'unavailable', message: 'The verified reader is unavailable. No result is shown.' };

describe('bounded Parent Home composition', () => {
  it('starts in a real loading state without SSR data reads or fabricated family facts', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<ParentHome />);
      expect(fetcher).not.toHaveBeenCalled();
      expect(html).toContain('Loading Parent Home');
      expect(html).toContain('Checking verified access');
      expect(html).not.toMatch(/Avery|Green Belt|Ideal Martial Arts|75%|Eian/);
    } finally { fetcher.mockRestore(); }
  });

  it('links only to existing parent destinations after their fixed family-safe reads succeed', () => {
    const html = renderToStaticMarkup(<ParentHomeCards journey={ready} testing={ready} billing={ready} />);
    for (const href of ['/parent/journey#schedule', '/parent/journey', '/parent/documents', '/parent/testing', '/parent/billing']) expect(html).toContain(`href="${href}"`);
    expect(html).toContain('Planned Absences');
    expect(html).toContain('A parent planned-absence read is not currently available');
    expect(html).not.toContain('Messages');
    expect(html).not.toMatch(/familyId|schoolId|studentProfileId/i);
  });

  it('shows explicit unavailable states without a destination link and omits cards whose read access was lost', () => {
    const html = renderToStaticMarkup(<ParentHomeCards journey={unavailable} testing={{ kind: 'access-lost', message: 'Family access lost.' }} billing={unavailable} />);
    expect(html).toContain('Student Journey');
    expect(html).toContain('Billing');
    expect(html).toContain('The verified reader is unavailable');
    expect(html).not.toContain('/parent/journey#schedule');
    expect(html).not.toContain('/parent/testing');
  });

  it('keeps the Home a client-only composition of existing strict readers with visual-only presentation controls', () => {
    const component = readFileSync('src/components/parent-home.tsx', 'utf8');
    const route = readFileSync('src/app/parent/page.tsx', 'utf8');
    const documents = readFileSync('src/app/parent/documents/page.tsx', 'utf8');
    for (const token of ['loadParentJourney', 'loadParentTestingStatus', 'loadParentBilling', 'HON_INTERFACE_THEMES', 'setJourney({ kind: \'access-lost\'', 'pending.current?.abort()', 'visibilitychange']) expect(component).toContain(token);
    expect(component).not.toMatch(/fetch\(|method:\s*'POST'|Idempotency-Key|X-HON-Human-Command|submitParentTestingInterest|sendMessage|invokeLLM|executeAction|payment provider/i);
    for (const text of ['cookieValue', 'verifySession', "redirect('/auth/login')", 'force-dynamic', 'index: false', 'follow: false', 'ParentHome']) expect(route).toContain(text);
    expect(route).not.toContain("redirect('/parent/journey')");
    for (const text of ['cookieValue', 'verifySession', "redirect('/auth/login')", 'force-dynamic', 'index: false', 'follow: false']) expect(documents).toContain(text);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((item: { path: string }) => item.path === '/parent')).toEqual([{ path: '/parent', title: 'HON | Parent Home' }]);
  });
});
