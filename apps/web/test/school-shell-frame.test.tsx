import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SchoolShellFrame, type SchoolShellFrameProps } from '../src/components/school-shell/frame';
import { shellText } from '../src/components/school-shell/copy';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const base: SchoolShellFrameProps = {
  path: '/staff/dashboard', language: 'en', phase: 'READY', selection: { organizationId: A, schoolId: B }, schoolName: null,
  choices: [], mode: 'modern', viewState: 'LOCAL', menuOpen: false,
  onMode: () => {}, onMenu: () => {}, onSwitch: () => {}, onChoose: () => {}, onRestore: () => {},
};
const esc = (value: string) => value.replaceAll('&', '&amp;');
const render = (props: Partial<SchoolShellFrameProps> = {}) => renderToStaticMarkup(
  <SchoolShellFrame {...base} {...props}><p data-testid="page">private page</p></SchoolShellFrame>);

describe('school shell frame', () => {
  it('wraps the exact page after a skip link and the primary navigation, leaving the main landmark to the page', () => {
    const html = render();
    expect(html).toContain('href="#hon-main"');
    expect(html).toMatch(/<div[^>]*id="hon-main"[^>]*>.*<p data-testid="page">private page<\/p>/s);
    // Pages render their own <main>; a second one around them would duplicate the landmark.
    expect(html).not.toContain('<main');
    for (const key of ['navHome', 'navHon', 'navAiTeam', 'navCrm', 'navStudents', 'navBilling', 'navClasses', 'navAttendance',
      'navMarketing', 'navCommunity', 'navAnalytics', 'navStaff', 'navSettings'] as const) expect(html).toContain(esc(shellText('en', key)));
  });

  it('marks the active primary item and its section tab', () => {
    const html = render({ path: '/staff/crm/follow-ups' });
    expect(html).toMatch(/aria-current="page"[^>]*data-nav="crm"|data-nav="crm"[^>]*aria-current="page"/);
    expect(html).toMatch(/<nav[^>]*aria-label="Pages in this section"/);
    expect(html).toMatch(/href="\/staff\/crm\/follow-ups"[^>]*aria-current="page"/);
  });

  it('adds the verified prefill to scoped links only when READY', () => {
    const ready = render();
    expect(ready).toContain(`href="/staff/dashboard?organizationId=${A}&amp;schoolId=${B}"`);
    expect(ready).toContain('href="/staff/memberships"');
    for (const phase of ['IDLE', 'LOADING', 'CHOICE', 'CONCEALED', 'SESSION', 'DENIED', 'UNAVAILABLE', 'IDENTITY'] as const) {
      const html = render({ phase, selection: phase === 'CONCEALED' ? null : base.selection });
      expect(html, phase).not.toContain('organizationId=');
      expect(html, phase).toContain(shellText('en', phase));
    }
  });

  it('names the school card region distinctly from any page field labelled School', () => {
    expect(render()).toContain('aria-label="Current school"');
    expect(render()).not.toContain('aria-label="School"');
  });

  it('never prints school identifiers, only a verified name when one is known', () => {
    expect(render()).not.toMatch(new RegExp(`>[^<]*${B}`));
    expect(render({ schoolName: 'Sunrise Taekwondo' })).toContain('Sunrise Taekwondo');
    expect(render({ phase: 'CONCEALED', selection: null, schoolName: null })).not.toContain('Sunrise');
  });

  it('lists named school choices only in CHOICE', () => {
    const choices = [{ organizationId: A, schoolId: B, organizationName: 'Org', schoolName: 'North Dojang' },
      { organizationId: A, schoolId: '33333333-3333-4333-8333-333333333333', organizationName: 'Org', schoolName: 'South Dojang' }];
    expect(render({ phase: 'CHOICE', selection: null, choices })).toContain('South Dojang');
    expect(render({ phase: 'READY', choices })).not.toContain('South Dojang');
  });

  it('offers sign-in instead of school controls when the session or identity ended', () => {
    for (const phase of ['SESSION', 'IDENTITY'] as const) {
      const html = render({ phase, selection: null });
      expect(html).toContain('href="/auth/login"');
      expect(html).not.toContain(shellText('en', 'switchSchool'));
    }
  });

  it('exposes the three platform views as pressed buttons and sets the mode on the root', () => {
    for (const mode of ['modern', 'classic', 'big-button'] as const) {
      const html = render({ mode });
      expect(html).toMatch(new RegExp(`data-hon-ui="school"[^>]*data-hon-mode="${mode}"|data-hon-mode="${mode}"[^>]*data-hon-ui="school"`));
      expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>${shellText('en', mode)}<`));
      // Distinct names: a page's own view picker keeps its plain "Modern"/"Classic" buttons.
      expect(html).toContain(`aria-label="${shellText('en', 'view')}: ${shellText('en', mode)}"`);
    }
  });

  it.each(['ko', 'es'] as const)('renders %s navigation copy', language => {
    const html = render({ language, path: '/staff/work' });
    expect(html).toContain(esc(shellText(language, 'navCrm')));
    expect(html).toContain(shellText(language, 'askHon'));
    expect(html).not.toContain('>CRM &amp; Sales<');
  });

  it('performs no network read while rendering', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    render(); expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
  });

  it('lays out Classic as a sidebar, Modern as a top bar and Big Button as cards, with one school region each', () => {
    const layout = (mode: 'modern' | 'classic' | 'big-button') => render({ mode }).match(/data-hon-layout="([^"]+)"/)?.[1];
    expect([layout('classic'), layout('modern'), layout('big-button')]).toEqual(['sidebar', 'topnav', 'cards']);
    for (const mode of ['modern', 'classic', 'big-button'] as const) expect(render({ mode }).match(/aria-label="Current school"/g)).toHaveLength(1);
  });

  it('opens a menu panel of every area outside Classic, and the sidebar drawer in Classic', () => {
    const panel = render({ mode: 'modern', menuOpen: true });
    expect(panel).toMatch(/role="dialog"[^>]*aria-label="Menu"/);
    for (const key of ['navHome', 'navCrm', 'navSettings'] as const) expect(panel.split('aria-label="Menu"')[1]).toContain(esc(shellText('en', key)));
    expect(render({ mode: 'big-button', menuOpen: true })).toContain('aria-label="Menu"');
    expect(render({ mode: 'classic', menuOpen: true })).not.toContain('aria-label="Menu"');
    expect(render({ mode: 'modern' })).not.toContain('role="dialog"');
  });

  it('makes the page behind the Menu panel inert and marks private school content for synchronous concealment', () => {
    const open = render({ mode: 'modern', menuOpen: true, path: '/staff/work' });
    expect(open).toContain('aria-modal="true"');
    expect((open.match(/ inert=""/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(render({ mode: 'modern', path: '/staff/work' })).not.toContain(' inert=""');
    const ready = render({ phase: 'READY', schoolName: 'Sunrise Taekwondo' });
    expect(ready).toMatch(/<strong data-shell-private="">Sunrise Taekwondo<\/strong>/);
    expect(render({ phase: 'CONCEALED', schoolName: null })).not.toContain('data-shell-private');
  });
  it('keeps HON in the corner on other pages, but not on the dashboard or in HON itself', () => {
    const launcher = /class="[^"]*honLauncher[^"]*" href="\/staff\/hon"/;
    expect(render({ path: '/staff/crm/leads' })).toMatch(launcher);
    expect(render({ path: '/staff/work', phase: 'SESSION', selection: null })).toMatch(launcher);
    expect(render({ path: '/staff/dashboard' })).not.toMatch(launcher);
    expect(render({ path: '/staff/hon' })).not.toMatch(launcher);
  });

  it('keeps the drawer closed unless the menu is open', () => {
    expect(render()).not.toMatch(/<dialog[^>]* open/);
    expect(render({ menuOpen: true })).toContain('data-drawer="open"');
  });
});
