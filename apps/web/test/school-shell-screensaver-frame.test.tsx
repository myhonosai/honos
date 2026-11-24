import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SchoolShellFrame, type SchoolShellFrameProps } from '../src/components/school-shell/frame';
import { shellText, SHELL_LANGUAGES } from '../src/components/school-shell/copy';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const base: SchoolShellFrameProps = {
  path: '/staff/students/conversations', language: 'en', phase: 'READY', selection: { organizationId: A, schoolId: B }, schoolName: 'Sunrise Taekwondo',
  choices: [], mode: 'modern', viewState: 'LOCAL', menuOpen: false,
  onMode: () => {}, onMenu: () => {}, onSwitch: () => {}, onChoose: () => {}, onRestore: () => {},
};
const render = (props: Partial<SchoolShellFrameProps> = {}) => renderToStaticMarkup(
  <SchoolShellFrame {...base} {...props}><p data-testid="page">private page</p></SchoolShellFrame>);

describe('school shell screensaver', () => {
  it('is not shown while the app is in use', () => {
    expect(render()).not.toContain('data-screensaver');
    expect(render({ asleep: false })).not.toContain('data-screensaver');
  });

  it('covers the app with the school name and a tap prompt, keeps the page mounted and the school selected underneath', () => {
    const html = render({ asleep: true });
    expect(html).toContain('data-orb-state="idle"'); // the living HON orb, decorative
    expect(html).toMatch(/<div[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Screensaver"[^>]*data-screensaver=""/);
    expect(html).toContain('Sunrise Taekwondo'); expect(html).toContain('Tap anywhere to continue');
    // Same page, same verified school and links: nothing to re-choose.
    expect(html).toContain('private page'); expect(html).toContain(`organizationId=${A}`);
    expect(html).not.toContain(shellText('en', 'showSchool'));
    // The app behind it is inert so nothing can be read out or clicked through.
    expect(html).toMatch(/<div class="[^"]*workspace[^"]*" inert=""/);
    expect(html).toMatch(/<nav[^>]*aria-label="Quick navigation"[^>]*inert=""/);
  });

  it('shows the generic school label when the name is not known, and never page content', () => {
    const html = render({ asleep: true, schoolName: null });
    const saver = /<div[^>]*data-screensaver=""[^>]*>(.*?)<\/small><\/div>/s.exec(html)?.[1] ?? '';
    expect(saver).toContain(shellText('en', 'READY')); expect(saver).not.toContain('private page'); expect(saver).not.toContain(B);
  });

  it('has the screensaver copy in every shell language and no longer says the school was hidden', () => {
    for (const language of SHELL_LANGUAGES) {
      for (const key of ['screensaverLabel', 'screensaverTap', 'screensaverHint'] as const) expect(shellText(language, key)).not.toBe('');
      expect(shellText(language, 'CONCEALED')).not.toMatch(/hidden while away|숨겼|oculta/i);
    }
  });
});
