import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DEFAULT_HON_INTERFACE_THEME, FAMILY_DEFAULT_HON_INTERFACE_THEME } from '@hon/design-system';
import { ParentHome } from '../src/components/parent-home';
import { ParentJourney } from '../src/components/parent-journey';

it('U8: family pages open in Big-Button / Phone; staff keep the shared default; the choice stays switchable', () => {
  expect(FAMILY_DEFAULT_HON_INTERFACE_THEME).toBe('big-button');
  expect(DEFAULT_HON_INTERFACE_THEME).toBe('modern');
  for (const html of [renderToStaticMarkup(<ParentHome/>), renderToStaticMarkup(<ParentJourney/>)]) {
    expect(html).toMatch(/^<main class="theme-big-button /);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Big-Button \/ Phone</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Modern HON</);
  }
});
