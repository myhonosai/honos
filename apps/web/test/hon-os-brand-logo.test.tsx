import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SchoolShellFrame, type SchoolShellFrameProps } from '../src/components/school-shell/frame';

// The owner-approved "spirit orbit" logo (2026-11-19) replaces the old diamond mark and the
// externally hosted favicon. Brand files are static, same-origin and carry no school data.
const BRAND = ['hon-os-mark.svg', 'hon-os-mark-dark.svg', 'hon-os-logo.svg', 'hon-os-logo-dark.svg', 'favicon.svg',
  'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const base: SchoolShellFrameProps = {
  path: '/staff/dashboard', language: 'en', phase: 'READY', selection: { organizationId: A, schoolId: B }, schoolName: null,
  choices: [], mode: 'modern', viewState: 'LOCAL', menuOpen: false,
  onMode: () => {}, onMenu: () => {}, onSwitch: () => {}, onChoose: () => {}, onRestore: () => {},
};

describe('HON OS logo', () => {
  it('ships every brand file as a same-origin static asset; the SVGs are self-contained vectors', () => {
    for (const file of BRAND) expect(existsSync(`public/brand/${file}`), file).toBe(true);
    for (const file of BRAND.filter(name => name.endsWith('.svg'))) {
      const svg = readFileSync(`public/brand/${file}`, 'utf8');
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), file).toBe(true);
      expect(svg, file).not.toMatch(/<script|<image|href=|@import|font-family/i);
    }
  });

  it('shows the spirit-orbit mark beside the HON OS name in the school shell, decorative to screen readers', () => {
    for (const mode of ['modern', 'classic', 'big-button'] as const) {
      const html = renderToStaticMarkup(<SchoolShellFrame {...base} mode={mode}><p>page</p></SchoolShellFrame>);
      expect(html).toMatch(/<img[^>]*src="\/brand\/hon-os-mark-dark\.svg"[^>]*alt=""|<img[^>]*alt=""[^>]*src="\/brand\/hon-os-mark-dark\.svg"/);
      expect(html).toContain('<strong>HON OS</strong>');
    }
  });

  it('shows the mark in the HQ rail and uses the brand favicon instead of the old hosted image', () => {
    const shell = readFileSync('src/components/hq-modern/shell.tsx', 'utf8');
    expect(shell).toMatch(/src="\/brand\/hon-os-mark-dark\.svg" alt=""/);
    const layout = readFileSync('src/app/layout.tsx', 'utf8');
    expect(layout).not.toContain('manus-storage');
    expect(layout).toContain("'/brand/favicon.svg'");
    expect(layout).toContain("'/brand/favicon.ico'");
    expect(layout).toContain("'/brand/apple-touch-icon.png'");
  });
});
