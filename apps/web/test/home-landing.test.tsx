import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import HomePage from '../src/app/page';

describe('public home page', () => {
  it('is a plain sign-in entry with no design-reference sample content', () => {
    const markup = renderToStaticMarkup(<HomePage />);
    expect(markup).toContain('href="/auth/login"');
    expect(markup).toContain('href="/auth/continue"');
    expect(markup).not.toMatch(/sample|reference|Command Center/i);
    expect(readFileSync('src/app/page.tsx', 'utf8')).not.toContain('HonReferenceSuite');
    expect(readFileSync('src/app/page.tsx', 'utf8')).toContain('robots: { index: false, follow: false }');
  });
  it('keeps the old Complete design reference at a no-index reference route', () => {
    const source = readFileSync('src/app/reference/complete/page.tsx', 'utf8');
    expect(source).toContain('<HonReferenceSuite screen="complete" />');
    expect(source).toContain('robots: { index: false, follow: false }');
  });
});

describe('sign-out control', () => {
  it('HQ and school shells sign out with a POST form instead of linking back to sign-in', () => {
    for (const file of ['src/components/hq-modern/shell.tsx', 'src/components/school-shell/frame.tsx']) {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('<SignOutButton');
    }
    expect(readFileSync('src/components/hq-modern/shell.tsx', 'utf8')).not.toContain('<Link href="/auth/login">{t("Account")}</Link>');
    expect(readFileSync('src/components/auth/sign-out-button.tsx', 'utf8')).toMatch(/method="post" action="\/auth\/logout"/);
  });
});
