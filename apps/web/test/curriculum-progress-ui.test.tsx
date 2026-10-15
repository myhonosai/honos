import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ParentJourneyUnavailable } from '../src/components/parent-journey-unavailable';
import { HonReferenceSuite } from '../src/components/hon-reference-suite';

describe('honest Parent Student Journey reference', () => {
  it('has no data calls, invented scores, child identity or approval promises', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<ParentJourneyUnavailable />);
      expect(fetcher).not.toHaveBeenCalled();
      expect(html).toContain('Student Journey unavailable');
      expect(html).toContain('No verified family data is connected');
      expect(html).toContain('No scores or progress are shown');
      expect(html).toContain('MET is not testing approval, promotion, or a guarantee');
      expect(html).not.toMatch(/Ava|Green Belt|8 \/ 10|progressbar|<meter|<progress/);
    } finally { fetcher.mockRestore(); }
  });
  it('the existing parent route renders the unavailable projection and no fake Journey', () => {
    const html = renderToStaticMarkup(<HonReferenceSuite screen="parent" />);
    expect(html).toContain('Student Journey unavailable');
    expect(html).not.toMatch(/Ava|8 \/ 10|7 \/ 10|6 \/ 10|9 \/ 10|Level 2/);
    const source = readFileSync(new URL('../src/components/parent-journey-unavailable.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/fetch\(|localStorage|sessionStorage|dangerouslySetInnerHTML/);
    const routes = JSON.parse(readFileSync(new URL('../public/manus-routes.json', import.meta.url), 'utf8'));
    expect(routes.routes.filter((r: {path: string}) => r.path === '/parent')).toHaveLength(1);
  });
});
